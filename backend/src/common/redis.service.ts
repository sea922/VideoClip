import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;
  private readonly DEFAULT_TTL = 7200; // 2 hours

  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
    });
  }

  async hset(key: string, data: Record<string, string | number>): Promise<void> {
    const flat: string[] = [];
    for (const [k, v] of Object.entries(data)) {
      flat.push(k, String(v));
    }
    await this.client.hset(key, ...flat);
    await this.client.expire(key, this.DEFAULT_TTL);
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const result = await this.client.hgetall(key);
    return Object.keys(result).length > 0 ? result : null;
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.client.expire(key, seconds);
  }

  async incr(key: string): Promise<number> {
    const val = await this.client.incr(key);
    await this.client.expire(key, 60); // 1-min window
    return val;
  }

  onModuleDestroy() {
    this.client.disconnect();
  }
}
