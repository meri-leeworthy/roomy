import { readFileSync, statSync } from 'fs';
import { extname } from 'path';
import sharp from 'sharp';
import { Agent } from '@atproto/api';

export interface BlueskyUploadOptions {
  maxSize?: number;
  quality?: number;
  mediaType?: 'auto' | 'image' | 'video';
}

export interface BlueskyUploadResult {
  url: string;
  mediaType: 'image' | 'video';
  originalSize?: { width: number; height: number };
  processedSize?: { width: number; height: number };
  duration?: number; // for videos
}

/**
 * Upload media (image or video) to Bluesky's CDN and return the URL
 */
export async function uploadMediaToBluesky(
  agent: Agent,
  filePath: string,
  options: BlueskyUploadOptions = {}
): Promise<BlueskyUploadResult> {
  try {
    console.log(`📸 Processing media: ${filePath}`);

    // Read and validate the file
    const fileBuffer = readFileSync(filePath);
    const fileStats = statSync(filePath);

    // Validate file size (max 10MB)
    const maxFileSize = 10 * 1024 * 1024; // 10MB
    if (fileStats.size > maxFileSize) {
      throw new Error(
        `File too large. Maximum size is ${maxFileSize / (1024 * 1024)}MB`
      );
    }

    // Determine media type
    const mediaType =
      options.mediaType === 'auto' || !options.mediaType
        ? detectMediaType(filePath)
        : options.mediaType;

    if (mediaType === 'image') {
      return await uploadImage(agent, fileBuffer, filePath, options);
    } else if (mediaType === 'video') {
      return await uploadVideo(agent, fileBuffer, filePath);
    } else {
      throw new Error(`Unsupported media type: ${mediaType}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to upload media to Bluesky: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Upload an image to Bluesky
 */
async function uploadImage(
  agent: Agent,
  fileBuffer: Buffer,
  filePath: string,
  options: BlueskyUploadOptions
): Promise<BlueskyUploadResult> {
  // Get image metadata
  const metadata = await sharp(fileBuffer).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('Invalid image file');
  }

  const originalSize = { width: metadata.width, height: metadata.height };

  // Calculate new dimensions
  const maxSize = options.maxSize || 2048;
  const { width: newWidth, height: newHeight } = calculateDimensions(
    metadata.width,
    metadata.height,
    maxSize
  );

  // Process the image
  const processedBuffer = await sharp(fileBuffer)
    .resize(newWidth, newHeight, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: options.quality || 85 })
    .toBuffer();

  // Create a Blob for upload
  const blob = new Blob([processedBuffer], { type: 'image/jpeg' });

  // Upload to Bluesky
  console.log('☁️ Uploading image to Bluesky CDN...');
  const resp = await agent.com.atproto.repo.uploadBlob(blob);
  const blobRef = resp.data.blob;

  // Create a record that links to the blob
  const record = {
    $type: 'chat.roomy.v0.images',
    image: blobRef,
    alt: 'User uploaded image',
  };

  // Put the record in the repository
  await agent.com.atproto.repo.putRecord({
    repo: agent.did!,
    collection: 'chat.roomy.v0.images',
    rkey: `${Date.now()}`,
    record: record,
  });

  // Generate the CDN URL (same format as the app)
  const url = `https://cdn.bsky.app/img/feed_thumbnail/plain/${agent.did}/${blobRef.ref}`;

  console.log('url', url);
  console.log(`✅ Image uploaded to Bluesky CDN!`);
  console.log(`   Original size: ${originalSize.width}x${originalSize.height}`);
  console.log(`   Processed size: ${newWidth}x${newHeight}`);

  return {
    url,
    mediaType: 'image',
    originalSize,
    processedSize: { width: newWidth, height: newHeight },
  };
}

/**
 * Upload a video to Bluesky
 */
async function uploadVideo(
  agent: Agent,
  fileBuffer: Buffer,
  filePath: string
): Promise<BlueskyUploadResult> {
  // For videos, we'll upload the original file without processing
  // Note: Bluesky may have specific video format requirements
  const extension = extname(filePath).toLowerCase();
  const mimeType = getVideoMimeType(extension);

  // Create a Blob for upload
  const blob = new Blob([fileBuffer], { type: mimeType });

  // Upload to Bluesky
  console.log('☁️ Uploading video to Bluesky CDN...');
  const resp = await agent.com.atproto.repo.uploadBlob(blob);
  const blobRef = resp.data.blob;

  // Create a record that links to the blob
  const record = {
    $type: 'chat.roomy.v0.videos',
    video: blobRef,
    alt: 'User uploaded video',
  };

  // Put the record in the repository
  await agent.com.atproto.repo.putRecord({
    repo: agent.did!,
    collection: 'chat.roomy.v0.videos',
    rkey: `${Date.now()}`,
    record: record,
  });

  // Generate the CDN URL for video
  const url = `https://cdn.bsky.app/video/plain/${agent.did}/${blobRef.ref}`;

  console.log('url', url);
  console.log(`✅ Video uploaded to Bluesky CDN!`);

  return {
    url,
    mediaType: 'video',
    duration: undefined, // Would need video processing library to extract this
  };
}

/**
 * Detect media type based on file extension
 */
function detectMediaType(filePath: string): 'image' | 'video' {
  const extension = extname(filePath).toLowerCase();

  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const videoExtensions = [
    '.mp4',
    '.mov',
    '.avi',
    '.mkv',
    '.webm',
    '.flv',
    '.wmv',
  ];

  if (imageExtensions.includes(extension)) {
    return 'image';
  } else if (videoExtensions.includes(extension)) {
    return 'video';
  } else {
    throw new Error(`Unsupported file extension: ${extension}`);
  }
}

/**
 * Get MIME type for video files
 */
function getVideoMimeType(extension: string): string {
  const mimeTypes: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.flv': 'video/x-flv',
    '.wmv': 'video/x-ms-wmv',
  };

  return mimeTypes[extension] || 'video/mp4';
}

/**
 * Calculate new dimensions while maintaining aspect ratio
 */
function calculateDimensions(
  originalWidth: number,
  originalHeight: number,
  maxSize: number
): { width: number; height: number } {
  if (originalWidth <= maxSize && originalHeight <= maxSize) {
    return { width: originalWidth, height: originalHeight };
  }

  const aspectRatio = originalWidth / originalHeight;

  if (originalWidth > originalHeight) {
    return {
      width: maxSize,
      height: Math.round(maxSize / aspectRatio),
    };
  } else {
    return {
      width: Math.round(maxSize * aspectRatio),
      height: maxSize,
    };
  }
}

/**
 * Validate if a file is a supported media format
 */
export function isSupportedMediaFormat(filePath: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const videoExtensions = [
    '.mp4',
    '.mov',
    '.avi',
    '.mkv',
    '.webm',
    '.flv',
    '.wmv',
  ];
  const supportedExtensions = [...imageExtensions, ...videoExtensions];
  const extension = extname(filePath).toLowerCase();
  return supportedExtensions.includes(extension);
}

/**
 * Validate if a file is a supported image format (legacy function)
 */
export function isSupportedImageFormat(filePath: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const extension = extname(filePath).toLowerCase();
  return imageExtensions.includes(extension);
}
