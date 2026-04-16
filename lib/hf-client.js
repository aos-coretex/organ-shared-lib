/**
 * HuggingFace Hub API client — MP-CONFIG-1 relay l9m-10.
 *
 * Minimal client over the public HF Hub API. Used by `hf-orchestrator.js` to
 * probe a repo, enumerate files at a pinned revision, and download weights to
 * the local cache. Public-only by default; private repos require `HF_TOKEN`.
 *
 * DESIGN CONSTRAINTS
 * ------------------
 * - fetch is injected (`opts.fetch`) so tests stub without network access.
 * - fs writers are injected (`opts.openWriteStream`) so tests stub without disk.
 * - No globals are mutated — each call takes its own dependencies.
 *
 * Subpath import: `@coretex/organ-boot/hf-client`
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const HF_API_BASE = 'https://huggingface.co';

function authHeaders(token) {
  if (!token) return {};
  return { authorization: `Bearer ${token}` };
}

/**
 * @typedef {object} HFClientOpts
 * @property {typeof fetch} [fetch]            — injected fetch (default: global fetch)
 * @property {string}       [token]            — HF API token (default: process.env.HF_TOKEN)
 * @property {string}       [baseUrl]          — API base URL (default: HF_API_BASE)
 * @property {(p:string)=>import('node:stream').Writable} [openWriteStream] — test hook
 */

export function createHFClient(opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const token = opts.token ?? process.env.HF_TOKEN;
  const baseUrl = opts.baseUrl || HF_API_BASE;
  const openWriteStream = opts.openWriteStream || createWriteStream;

  if (typeof fetchImpl !== 'function') {
    throw new Error('hf-client: no fetch implementation available');
  }

  /**
   * @param {string} repo
   * @param {string} revision  — pinned SHA or tag
   * @returns {Promise<object>} model info JSON (`siblings` lists files)
   */
  async function getModelInfo(repo, revision) {
    const url = `${baseUrl}/api/models/${encodeURIComponent(repo)}/revision/${encodeURIComponent(revision)}`;
    const res = await fetchImpl(url, { headers: authHeaders(token) });
    if (!res.ok) {
      const body = await safeText(res);
      const err = new Error(`hf-client: getModelInfo ${repo}@${revision} failed: ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return res.json();
  }

  /**
   * @param {string} repo
   * @param {string} revision
   * @returns {Promise<string[]>} list of file paths at the revision (siblings[].rfilename)
   */
  async function listSnapshot(repo, revision) {
    const info = await getModelInfo(repo, revision);
    if (!Array.isArray(info.siblings)) return [];
    return info.siblings.map((s) => s.rfilename).filter(Boolean);
  }

  /**
   * @param {string} repo
   * @param {string} revision
   * @param {string} filename   — path relative to the repo root
   * @param {string} targetDir  — local directory to place the file under (file name preserved)
   * @returns {Promise<{path:string, bytes:number}>}
   */
  async function downloadFile(repo, revision, filename, targetDir) {
    const url = `${baseUrl}/${encodeURIComponent(repo)}/resolve/${encodeURIComponent(revision)}/${filename}`;
    const res = await fetchImpl(url, { headers: authHeaders(token), redirect: 'follow' });
    if (!res.ok) {
      const body = await safeText(res);
      const err = new Error(`hf-client: downloadFile ${repo}@${revision}/${filename} failed: ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    await mkdir(targetDir, { recursive: true });
    const destPath = path.join(targetDir, path.basename(filename));
    const writable = openWriteStream(destPath);
    let bytes = 0;
    if (res.body && typeof res.body.getReader === 'function') {
      // WHATWG ReadableStream — convert to Node Readable for pipeline.
      const nodeStream = Readable.fromWeb(res.body);
      await pipeline(
        nodeStream,
        async function* (source) {
          for await (const chunk of source) {
            bytes += chunk.length;
            yield chunk;
          }
        },
        writable,
      );
    } else if (res.body) {
      await pipeline(res.body, writable);
    } else {
      writable.end();
    }
    return { path: destPath, bytes };
  }

  return { getModelInfo, listSnapshot, downloadFile };
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
