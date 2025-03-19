/**
 * Transcription Task Processor
 *
 * Subscribes to batch events and processes transcription-related tasks:
 * - Audio transcription
 * - Speaker diarization
 * - Transcript formatting
 */
import { updateTaskStatus } from "..";
import { db } from "../db";
import { $TaskType, BatchType, JobStatus } from "../db/models/db";
import { isTranscriptionTaskType } from "../db/models/json/TaskTypes";
import { batchCreated, taskCompleted } from "../topics";

import { media, transcription } from "~encore/clients";

import { api } from "encore.dev/api";
import log from "encore.dev/log";
import { Subscription } from "encore.dev/pubsub";

/**
 * List of transcription task types this processor handles
 */
const TRANSCRIPTION_TASK_TYPES = [
  TaskType.AUDIO_TRANSCRIBE,
  TaskType.SPEAKER_DIARIZE,
  TaskType.TRANSCRIPT_FORMAT,
];

/**
 * Process the next batch of available transcription tasks
 */
export const processNextTranscriptionTasks = api(
  {
    method: "POST",
    path: "/batch/transcription/process",
    expose: true,
  },
  async (params: {
    limit?: number;
  }): Promise<{
    processed: number;
  }> => {
    const { limit = 3 } = params;

    // Get next available tasks for transcription processing
    const nextTasks = await db.processingTask.findMany({
      where: {
        status: JobStatus.QUEUED,
        taskType: { in: TRANSCRIPTION_TASK_TYPES },
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: limit,
      // Include any task dependencies to check if they're satisfied
      include: {
        dependsOn: {
          include: {
            dependencyTask: true,
          },
        },
      },
    });

    // Filter for tasks that have all dependencies satisfied
    const availableTasks = nextTasks.filter((task) => {
      if (task.dependsOn.length === 0) return true;

      // All dependencies must be completed
      return task.dependsOn.every(
        (dep) => dep.dependencyTask.status === JobStatus.COMPLETED,
      );
    });

    if (availableTasks.length === 0) {
      return { processed: 0 };
    }

    log.info(`Processing ${availableTasks.length} transcription tasks`);

    let processedCount = 0;

    // Process each task
    for (const task of availableTasks) {
      try {
        // Mark task as processing
        await updateTaskStatus({
          taskId: task.id,
          status: JobStatus.PROCESSING,
        });

        // Process based on task type
        switch (task.taskType) {
          case TaskType.AUDIO_TRANSCRIBE:
            await processAudioTranscription(task);
            break;

          case TaskType.SPEAKER_DIARIZE:
            await processSpeakerDiarization(task);
            break;

          case TaskType.TRANSCRIPT_FORMAT:
            await processTranscriptFormatting(task);
            break;

          default:
            throw new Error(`Unsupported task type: ${task.taskType}`);
        }

        processedCount++;
      } catch (error) {
        log.error(`Failed to process transcription task ${task.id}`, {
          taskId: task.id,
          taskType: task.taskType,
          error: error instanceof Error ? error.message : String(error),
        });

        // Mark task as failed
        await updateTaskStatus({
          taskId: task.id,
          status: JobStatus.FAILED,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { processed: processedCount };
  },
);

/**
 * Process audio transcription task
 */
async function processAudioTranscription(task: any): Promise<void> {
  const input = task.input as {
    audioId: string;
    audioUrl?: string;
    meetingRecordId?: string;
    options?: {
      language?: string;
      model?: string;
      detectSpeakers?: boolean;
      wordTimestamps?: boolean;
    };
  };

  if (!input.audioId && !input.audioUrl) {
    throw new Error("No audio source provided for transcription");
  }

  // If we only have ID but no URL, get the audio URL first
  if (!input.audioUrl && input.audioId) {
    const audioInfo = await media.getMediaFile({ mediaId: input.audioId });
    input.audioUrl = audioInfo.url;
  }

  if (!input.audioUrl) {
    throw new Error("Could not determine audio URL for transcription");
  }

  // Configure transcription options
  const options = {
    language: input.options?.language || "en-US",
    model: input.options?.model || "medium",
    detectSpeakers: input.options?.detectSpeakers ?? true,
    wordTimestamps: input.options?.wordTimestamps ?? true,
    meetingRecordId: input.meetingRecordId,
  };

  // Process transcription
  const transcriptionResult = await transcription.transcribe({
    audioFileId: input.audioId,

    ...options,
  });

  // Update task with success
  await updateTaskStatus({
    taskId: task.id,
    status: JobStatus.COMPLETED,
    output: {
      transcriptionId: transcriptionResult.transcriptionId,
      audioId: input.audioId,
      textLength: transcriptionResult.textLength,
      durationSeconds: transcriptionResult.durationSeconds,
      speakerCount: transcriptionResult.speakerCount,
    },
  });

  log.info(`Successfully transcribed audio for task ${task.id}`, {
    taskId: task.id,
    audioId: input.audioId,
    transcriptionId: transcriptionResult.transcriptionId,
  });
}

/**
 * Process speaker diarization task
 */
async function processSpeakerDiarization(task: any): Promise<void> {
  const input = task.input as {
    transcriptionId: string;
    meetingRecordId?: string;
    options?: {
      minSpeakers?: number;
      maxSpeakers?: number;
    };
  };

  if (!input.transcriptionId) {
    throw new Error("No transcription ID provided for diarization");
  }

  // Configure diarization options
  const options = {
    minSpeakers: input.options?.minSpeakers || 1,
    maxSpeakers: input.options?.maxSpeakers || 10,
    meetingRecordId: input.meetingRecordId,
  };

  // Process diarization
  const diarizationResult = await transcription.diarizeSpeakers({
    transcriptionId: input.transcriptionId,
    options,
  });

  // Update task with success
  await updateTaskStatus({
    taskId: task.id,
    status: JobStatus.COMPLETED,
    output: {
      transcriptionId: input.transcriptionId,
      diarizationId: diarizationResult.diarizationId,
      speakerCount: diarizationResult.speakerCount,
    },
  });

  log.info(`Successfully diarized speakers for task ${task.id}`, {
    taskId: task.id,
    transcriptionId: input.transcriptionId,
    speakerCount: diarizationResult.speakerCount,
  });
}

/**
 * Process transcript formatting task
 */
async function processTranscriptFormatting(task: any): Promise<void> {
  const input = task.input as {
    transcriptionId: string;
    meetingRecordId?: string;
    format?: "json" | "txt" | "srt" | "vtt" | "html";
  };

  if (!input.transcriptionId) {
    throw new Error("No transcription ID provided for formatting");
  }

  // Set default format
  const format = input.format || "json";

  // Process formatting
  const formattedResult = await transcription.formatTranscript({
    transcriptionId: input.transcriptionId,
    format,
    meetingRecordId: input.meetingRecordId,
  });

  // Update task with success
  await updateTaskStatus({
    taskId: task.id,
    status: JobStatus.COMPLETED,
    output: {
      transcriptionId: input.transcriptionId,
      format,
      outputUrl: formattedResult.outputUrl,
      byteSize: formattedResult.byteSize,
    },
  });

  log.info(`Successfully formatted transcript for task ${task.id}`, {
    taskId: task.id,
    transcriptionId: input.transcriptionId,
    format,
  });
}

/**
 * Queue a transcription job for audio
 */
export const queueTranscription = api(
  {
    method: "POST",
    path: "/batch/transcription/queue",
    expose: true,
  },
  async (params: {
    audioId: string;
    meetingRecordId?: string;
    options?: {
      language?: string;
      model?: string;
      detectSpeakers?: boolean;
      wordTimestamps?: boolean;
      format?: "json" | "txt" | "srt" | "vtt" | "html";
    };
    priority?: number;
  }): Promise<{
    batchId: string;
    tasks: string[];
  }> => {
    const { audioId, meetingRecordId, options, priority = 5 } = params;

    if (!audioId) {
      throw new Error("No audio ID provided");
    }

    // Create a batch for this transcription job
    const batch = await db.processingBatch.create({
      data: {
        batchType: BatchType.TRANSCRIPTION,
        status: JobStatus.QUEUED,
        priority,
        name: `Transcription: ${audioId}`,
        totalTasks: options?.detectSpeakers !== false ? 3 : 2, // Transcribe + Format + optional Diarize
        queuedTasks: options?.detectSpeakers !== false ? 3 : 2,
        metadata: {
          audioId,
          meetingRecordId,
          options,
        },
      },
    });

    // Create transcription task
    const transcribeTask = await db.processingTask.create({
      data: {
        batchId: batch.id,
        taskType: TaskType.AUDIO_TRANSCRIBE,
        status: JobStatus.QUEUED,
        priority,
        input: {
          audioId,
          meetingRecordId,
          options: {
            language: options?.language,
            model: options?.model,
            wordTimestamps: options?.wordTimestamps,
            detectSpeakers: options?.detectSpeakers,
          },
        },
        meetingRecordId,
      },
    });

    const tasks = [transcribeTask.id];

    // Create diarization task if requested
    if (options?.detectSpeakers !== false) {
      const diarizeTask = await db.processingTask.create({
        data: {
          batchId: batch.id,
          taskType: TaskType.SPEAKER_DIARIZE,
          status: JobStatus.QUEUED,
          priority,
          input: {
            taskType: TaskType.SPEAKER_DIARIZE,
            meetingRecordId,
          },
          meetingRecordId,
          dependsOn: {
            create: {
              dependencyTaskId: transcribeTask.id,
            },
          },
        },
      });
      tasks.push(diarizeTask.id);
    }

    // Create formatting task
    const formatTask = await db.processingTask.create({
      data: {
        batchId: batch.id,
        taskType: TaskType.TRANSCRIPT_FORMAT,
        status: JobStatus.QUEUED,
        priority,
        input: {
          meetingRecordId,
          format: options?.format || "json",
        },
        meetingRecordId,
        dependsOn: {
          create: {
            dependencyTaskId: transcribeTask.id,
          },
        },
      },
    });
    tasks.push(formatTask.id);

    // Publish batch created event
    await batchCreated.publish({
      batchId: batch.id,
      batchType: BatchType.TRANSCRIPTION,
      taskCount: tasks.length,
      metadata: {
        audioId,
        meetingRecordId,
      },
      timestamp: new Date(),
      sourceService: "batch",
    });

    log.info(
      `Queued transcription batch ${batch.id} with ${tasks.length} tasks for audio ${audioId}`,
    );

    return {
      batchId: batch.id,
      tasks,
    };
  },
);

/**
 * Queue a batch transcription job for multiple audio files
 */
export const queueBatchTranscription = api(
  {
    method: "POST",
    path: "/batch/transcription/queue-batch",
    expose: true,
  },
  async (params: {
    audioIds: string[];
    meetingRecordIds?: string[];
    options?: {
      language?: string;
      model?: string;
      detectSpeakers?: boolean;
      wordTimestamps?: boolean;
      format?: "json" | "txt" | "srt" | "vtt" | "html";
    };
    priority?: number;
  }): Promise<{
    batchId: string;
    taskCount: number;
  }> => {
    const { audioIds, meetingRecordIds, options, priority = 5 } = params;

    if (!audioIds.length) {
      throw new Error("No audio IDs provided");
    }

    // Create a batch with transcription tasks
    const batch = await db.processingBatch.create({
      data: {
        batchType: BatchType.TRANSCRIPTION,
        status: JobStatus.QUEUED,
        priority,
        name: `Batch Transcription: ${audioIds.length} files`,
        totalTasks: audioIds.length,
        queuedTasks: audioIds.length,
        metadata: {
          type: BatchType.TRANSCRIPTION,
          audioCount: audioIds.length,
          options,
        },
      },
    });

    // Create a task for each audio file
    let taskCount = 0;
    for (let i = 0; i < audioIds.length; i++) {
      const audioId = audioIds[i];
      const meetingRecordId = meetingRecordIds?.[i];

      // Use the main queue transcription endpoint for each audio
      try {
        await queueTranscription({
          audioId,
          meetingRecordId,
          options,
          priority,
        });

        taskCount++;
      } catch (error) {
        log.error(`Failed to queue transcription for audio ${audioId}`, {
          audioId,
          meetingRecordId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Publish batch created event
    await batchCreated.publish({
      batchId: batch.id,
      batchType: BatchType.TRANSCRIPTION,
      taskCount,
      metadata: {
        audioCount: audioIds.length,
        type: BatchType.TRANSCRIPTION,
        options,
      },
      timestamp: new Date(),
      sourceService: "batch",
    });

    log.info(
      `Queued batch transcription with ${taskCount} tasks for ${audioIds.length} audio files`,
    );

    return {
      batchId: batch.id,
      taskCount,
    };
  },
);

/**
 * Subscription that listens for batch creation events and schedules
 * automatic processing of transcription tasks
 */
const _ = new Subscription(batchCreated, "transcription-batch-processor", {
  handler: async (event) => {
    // Only process batches of type "transcription"
    if (event.batchType !== BatchType.TRANSCRIPTION) return;

    log.info(`Detected new transcription batch ${event.batchId}`, {
      batchId: event.batchId,
      taskCount: event.taskCount,
    });

    // Process this batch of transcription tasks
    try {
      await processNextTranscriptionTasks({ limit: event.taskCount });
    } catch (error) {
      log.error(`Failed to process transcription batch ${event.batchId}`, {
        batchId: event.batchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

/**
 * Subscription that listens for task completion events to trigger dependent tasks
 */
const __ = new Subscription(
  taskCompleted,
  "transcription-task-completion-handler",
  {
    handler: async (event) => {
      // Only focus on transcription-related tasks
      if (!isTranscriptionTaskType(event.taskType)) return;

      // Skip failed tasks
      if (!event.success) return;

      // If a transcription task completed, we need to update any dependent tasks
      if (event.taskType === TaskType.AUDIO_TRANSCRIBE) {
        // Find dependent tasks (diarization and formatting)
        const dependentTasks = await db.taskDependency.findMany({
          where: {
            dependencyTaskId: event.taskId,
          },
          include: {
            dependencyTask: true,
          },
        });

        // For each dependent task, update its input with the transcription ID
        for (const dep of dependentTasks) {
          const task = dep.dependencyTask;

          // If the task is a speaker diarization or transcript format task
          if (
            [TaskType.SPEAKER_DIARIZE, TaskType.TRANSCRIPT_FORMAT].includes(
              task.taskType,
            )
          ) {
            const output = event.output;

            // Update the task input with the transcription ID
            await db.processingTask.update({
              where: { id: task.id },
              data: {
                input: {
                  ...task.input,
                  transcriptionId: output?.transcriptionId,
                },
              },
            });

            log.info(
              `Updated dependent task ${task.id} with transcription ID ${output?.transcriptionId}`,
              {
                taskId: task.id,
                taskType: task.taskType,
                transcriptionId: output?.transcriptionId,
              },
            );
          }
        }
      }
    },
  },
);
