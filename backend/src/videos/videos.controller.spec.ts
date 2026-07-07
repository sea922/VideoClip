import { Test, TestingModule } from '@nestjs/testing';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { HttpStatus, HttpException } from '@nestjs/common';

describe('VideosController', () => {
  let controller: VideosController;
  let service: jest.Mocked<VideosService>;

  beforeEach(async () => {
    const mockVideosService = {
      submitVideo: jest.fn(),
      getVideo: jest.fn(),
      getStreamUrl: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [VideosController],
      providers: [
        {
          provide: VideosService,
          useValue: mockVideosService,
        },
      ],
    }).compile();

    controller = module.get<VideosController>(VideosController);
    service = module.get(VideosService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('submitVideo', () => {
    it('should submit a video and return jobId and videoId', async () => {
      const dto = { url: 'https://youtube.com/watch?v=test' };
      service.submitVideo.mockResolvedValue({ videoId: 'vid1', jobId: 'job1' });

      const result = await controller.submitVideo(dto);

      expect(service.submitVideo).toHaveBeenCalledWith(dto);
      expect(result).toEqual({ videoId: 'vid1', jobId: 'job1' });
    });
  });

  describe('getVideo', () => {
    it('should return video metadata', async () => {
      const meta = {
        videoId: 'vid1',
        s3Key: 'some/key.mp4',
        duration: 100,
        title: 'Title',
        thumbnailUrl: 'thumb.jpg'
      };
      service.getVideo.mockResolvedValue(meta);

      const result = await controller.getVideo('vid1');

      expect(service.getVideo).toHaveBeenCalledWith('vid1');
      expect(result).toEqual(meta);
    });
  });

  describe('streamVideo', () => {
    it('should return a redirect response to stream url', async () => {
      service.getStreamUrl.mockResolvedValue('https://signed-url.com');

      const result = await controller.streamVideo('vid1');

      expect(service.getStreamUrl).toHaveBeenCalledWith('vid1');
      expect(result).toEqual({ url: 'https://signed-url.com', statusCode: 302 });
    });
  });
});
