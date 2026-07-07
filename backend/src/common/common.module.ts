import { Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { StorageService } from './storage.service';

@Module({
  providers: [RedisService, StorageService],
  exports: [RedisService, StorageService],
})
export class CommonModule {}
