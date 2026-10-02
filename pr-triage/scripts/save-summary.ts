#!/usr/bin/env node
// Usage: save-summary.ts <owner/repo#n> <headSha> <block-file>
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SummaryCache } from './lib.ts'

const SUMMARIES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'summaries.json')

const [key, sha, blockFile] = process.argv.slice(2)
if (!key || !sha || !blockFile) {
    console.error('usage: save-summary <owner/repo#n> <headSha> <block-file>')
    process.exit(1)
}

const cache: SummaryCache = existsSync(SUMMARIES_PATH) ? JSON.parse(readFileSync(SUMMARIES_PATH, 'utf8')) : {}
cache[key] = { sha, block: readFileSync(blockFile, 'utf8').trim() }
writeFileSync(SUMMARIES_PATH + '.tmp', JSON.stringify(cache, null, 2) + '\n')
renameSync(SUMMARIES_PATH + '.tmp', SUMMARIES_PATH)
