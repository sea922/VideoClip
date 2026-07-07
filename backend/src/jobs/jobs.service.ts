import { Injectable, NotFoundException } from '@nestjs/common';
import { Queue, Job } from 'bullmq';

export interface JobStatus {
  id: string;
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown';
  progress: number;
  error?: string;
  returnValue?: unknown;
}

@Injectable()
export class JobsService {
  constructor(
    private readonly downloadQueue: Queue,
    private readonly exportQueue: Queue,
  ) {}

  private readonly queues: Queue[];

  // Called from module — inject queue references
  setQueues(download: Queue, exp: Queue) {
    (this as any).downloadQueue = download;
    (this as any).exportQueue = exp;
  }

  async getJob(jobId: string): Promise<JobStatus> {
    // Search both queues
    let job: Job | undefined;

    for (const queue of [this.downloadQueue, this.exportQueue]) {
      const found = await queue.getJob(jobId);
      if (found) {
        job = found;
        break;
      }
    }

    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    const state = await job.getState();
    const progress =
      typeof job.progress === 'number' ? job.progress : 0;

    return {
      id: job.id!,
      status: state as JobStatus['status'],
      progress,
      error: job.failedReason,
      returnValue: job.returnvalue,
    };
  }

  getDownloadQueue(): Queue {
    return this.downloadQueue;
  }

  getExportQueue(): Queue {
    return this.exportQueue;
  }
}
