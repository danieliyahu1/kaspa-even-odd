import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ProtocolError } from './protocol.js';

export class BackendGameStore {
  constructor(filePath) {
    if (!filePath) throw new ProtocolError('STORAGE_UNAVAILABLE', 'Backend game store path is required');
    this.filePath = filePath;
    this.writeQueue = Promise.resolve();
  }

  async loadPrepared(preparedHash) {
    return clone((await this.#read()).prepared[preparedHash] ?? null);
  }

  async savePrepared(record) {
    await this.#update((data) => { data.prepared[record.preparedHash] = record; });
  }

  async loadGame(gameId) {
    return clone((await this.#read()).games[gameId] ?? null);
  }

  async saveGame(record) {
    await this.#update((data) => { data.games[record.gameId] = record; });
  }

  async loadJoinPrepared(preparedHash) {
    return clone((await this.#read()).joinPrepared[preparedHash] ?? null);
  }

  async saveJoinPrepared(record) {
    await this.#update((data) => { data.joinPrepared[record.preparedHash] = record; });
  }

  async loadActionPrepared(preparedHash) {
    return clone((await this.#read()).actionPrepared[preparedHash] ?? null);
  }

  async saveActionPrepared(record) {
    await this.#update((data) => { data.actionPrepared[record.preparedHash] = record; });
  }

  async #update(change) {
    this.writeQueue = this.writeQueue.then(async () => {
      const data = await this.#read();
      change(data);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(data, null, 2));
      await rename(temporary, this.filePath);
    });
    return this.writeQueue;
  }

  async #read() {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8'));
      return { prepared: value.prepared ?? {}, games: value.games ?? {}, joinPrepared: value.joinPrepared ?? {}, actionPrepared: value.actionPrepared ?? {} };
    } catch (error) {
      if (error?.code === 'ENOENT') return { prepared: {}, games: {}, joinPrepared: {}, actionPrepared: {} };
      throw new ProtocolError('STORAGE_UNAVAILABLE', `Unable to read backend game store: ${error.message}`);
    }
  }
}

function clone(value) {
  return value === null ? null : structuredClone(value);
}
