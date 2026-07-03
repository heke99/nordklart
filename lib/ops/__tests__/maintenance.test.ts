import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getMaintenanceMode,
  maintenanceBlocksWrites,
  getMaintenanceMessage,
} from '../maintenance'

let prevMode: string | undefined
let prevMessage: string | undefined

beforeEach(() => {
  prevMode = process.env.MAINTENANCE_MODE
  prevMessage = process.env.MAINTENANCE_MESSAGE
})

afterEach(() => {
  if (prevMode === undefined) delete process.env.MAINTENANCE_MODE
  else process.env.MAINTENANCE_MODE = prevMode
  if (prevMessage === undefined) delete process.env.MAINTENANCE_MESSAGE
  else process.env.MAINTENANCE_MESSAGE = prevMessage
})

describe('maintenance mode', () => {
  it('defaults to off', () => {
    delete process.env.MAINTENANCE_MODE
    expect(getMaintenanceMode()).toBe('off')
    expect(maintenanceBlocksWrites()).toBe(false)
  })

  it('banner mode shows banner but allows writes', () => {
    process.env.MAINTENANCE_MODE = 'banner'
    expect(getMaintenanceMode()).toBe('banner')
    expect(maintenanceBlocksWrites()).toBe(false)
  })

  it('read_only mode blocks writes (accepts both spellings)', () => {
    process.env.MAINTENANCE_MODE = 'read_only'
    expect(maintenanceBlocksWrites()).toBe(true)
    process.env.MAINTENANCE_MODE = 'readonly'
    expect(getMaintenanceMode()).toBe('read_only')
  })

  it('unknown values are treated as off (fail open, not locked out)', () => {
    process.env.MAINTENANCE_MODE = 'nonsense'
    expect(getMaintenanceMode()).toBe('off')
  })

  it('message override wins; defaults are Swedish', () => {
    process.env.MAINTENANCE_MODE = 'read_only'
    delete process.env.MAINTENANCE_MESSAGE
    expect(getMaintenanceMessage()).toMatch(/läsläge/)

    process.env.MAINTENANCE_MESSAGE = 'Incident pågår — vi felsöker.'
    expect(getMaintenanceMessage()).toBe('Incident pågår — vi felsöker.')
  })
})
