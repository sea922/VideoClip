import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable global validation via class-validator DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,          // Strip unknown fields
      forbidNonWhitelisted: true,
      transform: true,          // Auto-transform payloads to DTO classes
    }),
  );

  app.enableCors({ origin: '*' });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Backend running on port ${port}`);
}
bootstrap();
