import { Controller, Get, Param, Sse, MessageEvent } from '@nestjs/common';
import { JobsService, JobStatus } from './jobs.service';
import { JobState } from './jobs.enum';
import { Observable, interval, from } from 'rxjs';
import { map, switchMap, takeWhile, distinctUntilChanged } from 'rxjs/operators';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get()
  getAllJobs() {
    return this.jobsService.getAllJobs();
  }

  @Get(':id')
  getJob(@Param('id') id: string): Promise<JobStatus> {
    return this.jobsService.getJob(id);
  }

  @Sse(':id/progress')
  jobProgress(@Param('id') id: string): Observable<MessageEvent> {
    return interval(500).pipe(
      switchMap(() => from(this.jobsService.getJob(id))),
      distinctUntilChanged((prev, curr) => 
        prev.status === curr.status && prev.progress === curr.progress
      ),
      takeWhile((job) => job.status !== JobState.COMPLETED && job.status !== JobState.FAILED, true),
      map((job) => ({
        data: job,
      } as MessageEvent)),
    );
  }
}
