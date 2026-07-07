import { Test, TestingModule } from '@nestjs/testing';
import { VideosService } from './videos.service';
import { RedisService } from '../common/redis.service';
import { StorageService } from '../common/storage.service';
import { HttpException, NotFoundException, HttpStatus } from '@nestjs/common';

describe('VideosService', () => {
  let service: VideosService;
  let downloadQueue: any;
  let redisService: jest.Mocked<RedisService>;
  let storageService: jest.Mocked<StorageService>;

  beforeEach(async () => {
    downloadQueue = {
      getWaitingCount: jest.fn(),
      add: jest.fn(),
    };

    const mockRedisService = {
      hgetall: jest.fn(),
    };

    const mockStorageService = {
      generatePresignedUrl: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: 'DOWNLOAD_QUEUE',
          useValue: downloadQueue,
        },
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
        {
          provide: StorageService,
          useValue: mockStorageService,
        },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
    redisService = module.get(RedisService);
    storageService = module.get(StorageService);
    
    process.env.QUEUE_MAX_DEPTH = '10';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('submitVideo', () => {
    it('should add a download job to the queue', async () => {
      downloadQueue.getWaitingCount.mockResolvedValue(0);
      downloadQueue.add.mockResolvedValue({ id: 'job-id-123' });

      const dto = { url: 'https://youtube.com/watch?v=test' };
      const result = await service.submitVideo(dto);

      expect(downloadQueue.getWaitingCount).toHaveBeenCalled();
      expect(downloadQueue.add).toHaveBeenCalledWith(
        'download',
        expect.objectContaining({ url: dto.url, videoId: expect.any(String) }),
        expect.objectContaining({ jobId: expect.any(String) })
      );
      expect(result).toHaveProperty('videoId');
      expect(result.jobId).toBe('job-id-123');
    });

    it('should throw TOO_MANY_REQUESTS if queue is full', async () => {
      downloadQueue.getWaitingCount.mockResolvedValue(10); // MAX_DEPTH is 10

      const dto = { url: 'https://youtube.com/watch?v=test' };
      await expect(service.submitVideo(dto)).rejects.toThrow(HttpException);
      
      try {
        await service.submitVideo(dto);
      } catch (err: any) {
        expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect(err.message).toBe('Server is busy — please try again in a few minutes');
      }
      
      expect(downloadQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('getVideo', () => {
    it('should return parsed video metadata from redis', async () => {
      redisService.hgetall.mockResolvedValue({
        s3Key: 'path/to.mp4',
        duration: '120.5',
        title: 'My Video',
        thumbnailUrl: 'http://thumb'
      });

      const result = await service.getVideo('vid-123');

      expect(redisService.hgetall).toHaveBeenCalledWith('video:vid-123');
      expect(result).toEqual({
        videoId: 'vid-123',
        s3Key: 'path/to.mp4',
        duration: 120.5,
        title: 'My Video',
        thumbnailUrl: 'http://thumb'
      });
    });

    it('should throw NotFoundException if video data is missing in redis', async () => {
      redisService.hgetall.mockResolvedValue(null as any);

      await expect(service.getVideo('vid-123')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getStreamUrl', () => {
    it('should return a presigned url if s3Key is present', async () => {
      redisService.hgetall.mockResolvedValue({ s3Key: 'path/to.mp4' });
      storageService.generatePresignedUrl.mockResolvedValue('https://signed.com');

      const result = await service.getStreamUrl('vid-123');

      expect(storageService.generatePresignedUrl).toHaveBeenCalledWith('path/to.mp4', 3600);
      expect(result).toBe('https://signed.com');
    });

    it('should throw NotFoundException if s3Key is missing', async () => {
      redisService.hgetall.mockResolvedValue({ someOtherKey: 'val' });

      await expect(service.getStreamUrl('vid-123')).rejects.toThrow(NotFoundException);
    });
  });
});
