import { Injectable, NotFoundException } from '@nestjs/common';
import { Queue, Job } from 'bullmq';
import { JobState } from './jobs.enum';

export interface JobStatus {
  id: string;
  status: JobState;
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

  async getAllJobs(): Promise<any[]> {
    const types = [
      JobState.COMPLETED,
      JobState.FAILED,
      JobState.ACTIVE,
      JobState.WAITING,
      JobState.DELAYED,
    ] as any;
    const downloadJobs = await this.downloadQueue.getJobs(types);
    const exportJobs = await this.exportQueue.getJobs(types);

    const mapJob = async (job: Job, type: 'download' | 'export') => {
      const state = await job.getState();
      const progress = typeof job.progress === 'number' ? job.progress : 0;
      return {
        id: job.id,
        type,
        status: state,
        progress,
        createdAt: job.timestamp,
        data: job.data,
        error: job.failedReason,
        returnValue: job.returnvalue,
      };
    };

    const mappedDownloads = await Promise.all(downloadJobs.map(j => mapJob(j, 'download')));
    const mappedExports = await Promise.all(exportJobs.map(j => mapJob(j, 'export')));

    const allJobs = [...mappedDownloads, ...mappedExports];
    allJobs.sort((a, b) => b.createdAt - a.createdAt); // newest first

    return allJobs;
  }
}
