/**
 * In-memory async-job registry for long-running packaging tasks.
 *
 * The API layer creates a job, returns the `jobId`, then the frontend polls
 * `GET /package/jobs/:id` for progress.
 */

import { randomUUID } from 'node:crypto';

export type JobStatus = 'pending' | 'running' | 'success' | 'failed';

export interface JobRecord {
  id: string;
  slug: string;
  platform: string;
  status: JobStatus;
  phase: string;
  logTail: string[];
  createdAt: number;
  finishedAt?: number;
  result?: Record<string, unknown>;
}

const LOG_TAIL_MAX = 200;

const jobs = new Map<string, JobRecord>();

export function createJob(slug: string, platform: string): JobRecord {
  const job: JobRecord = {
    id: randomUUID(),
    slug,
    platform,
    status: 'pending',
    phase: 'queued',
    logTail: [],
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, patch: Partial<Pick<JobRecord, 'status' | 'phase' | 'finishedAt' | 'result'>>): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
}

export function appendLog(id: string, line: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.logTail.push(line);
  if (job.logTail.length > LOG_TAIL_MAX) {
    job.logTail = job.logTail.slice(-LOG_TAIL_MAX);
  }
}

export function makeProgressFn(jobId: string): (phase: string, line?: string) => void {
  return (phase: string, line?: string) => {
    updateJob(jobId, { phase });
    if (line) appendLog(jobId, `[${phase}] ${line}`);
  };
}
