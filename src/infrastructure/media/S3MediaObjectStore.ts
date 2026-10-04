import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { MediaObjectStore } from "../../application/media/ports.ts";

/** Minimal structural view of the S3 client used by this adapter. */
export interface S3SendClient {
  send(command: HeadObjectCommand | PutObjectCommand): Promise<unknown>;
}

export type ReadUrlSigner = (bucket: string, key: string, expiresInSeconds: number) => Promise<string>;

/** Default signer: a short-lived, read-only pre-signed GET (ADR-016). Signing is local; no network call. */
export function createS3ReadUrlSigner(client: S3Client): ReadUrlSigner {
  return (bucket, key, expiresIn) => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

/**
 * Private S3 media bucket adapter. The bucket name and object keys stay inside
 * Infrastructure: callers only ever see the signed URL.
 */
export class S3MediaObjectStore implements MediaObjectStore {
  private readonly client: S3SendClient;
  private readonly bucketName: string;
  private readonly signReadUrl: ReadUrlSigner;

  constructor(client: S3SendClient, bucketName: string, signReadUrl: ReadUrlSigner) {
    this.client = client;
    this.bucketName = bucketName;
    this.signReadUrl = signReadUrl;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucketName, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async put(key: string, content: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: content,
      ContentType: contentType,
      CacheControl: "private, max-age=86400",
    }));
  }

  createReadUrl(key: string, expiresInSeconds: number): Promise<string> {
    return this.signReadUrl(this.bucketName, key, expiresInSeconds);
  }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === "NotFound" || candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}
