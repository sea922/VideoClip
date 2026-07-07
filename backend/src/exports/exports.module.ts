import { Module } from '@nestjs/common';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';
import { CommonModule } from '../common/common.module';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [CommonModule, JobsModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
