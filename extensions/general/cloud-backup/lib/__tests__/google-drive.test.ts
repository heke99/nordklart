import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ensureFolder, uploadFile } from '../google-drive'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('ensureFolder', () => {
  it('returns existing folder when found', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ files: [{ id: 'folder-1', name: 'nordklart' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const folder = await ensureFolder('at', 'nordklart', null)
    expect(folder.id).toBe('folder-1')
    // Only the search call; no create needed.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/files?q=')
    expect(decodeURIComponent(url)).toContain(`name = 'nordklart'`)
    expect(decodeURIComponent(url)).toContain(`'root' in parents`)
  })

  it('creates a new folder when none exists', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ files: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'new-id', name: 'nordklart' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    const folder = await ensureFolder('at', 'nordklart', null)
    expect(folder.id).toBe('new-id')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const createCall = fetchMock.mock.calls[1]
    expect((createCall[1] as RequestInit).method).toBe('POST')
    const body = JSON.parse(String((createCall[1] as RequestInit).body))
    expect(body.mimeType).toBe('application/vnd.google-apps.folder')
    expect(body.name).toBe('nordklart')
  })

  it('escapes single quotes in folder name and scopes to parent', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        // findFolderByName → match so we never hit create.
        new Response(JSON.stringify({ files: [{ id: 'x', name: "Kalle's" }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    await ensureFolder('at', "Kalle's", 'parent-id')
    const searchUrl = decodeURIComponent(fetchMock.mock.calls[0][0] as string)
    expect(searchUrl).toContain(`name = 'Kalle\\'s'`)
    expect(searchUrl).toContain(`'parent-id' in parents`)
  })
})

describe('uploadFile', () => {
  it('posts multipart body with metadata + binary and returns parsed result', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'file-123',
          name: 'arkiv.zip',
          size: '2048',
          webViewLink: 'https://drive.google.com/file/d/file-123/view',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const data = new Uint8Array([1, 2, 3, 4, 5]).buffer
    const result = await uploadFile('access-tok', 'folder-1', 'arkiv.zip', data)

    expect(result.id).toBe('file-123')
    expect(result.size_bytes).toBe(2048)
    expect(result.web_view_link).toContain('file-123')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('uploadType=multipart')
    const contentType = (init as RequestInit).headers as Record<string, string>
    expect(contentType.Authorization).toBe('Bearer access-tok')
    expect(contentType['Content-Type']).toContain('multipart/related')
    // Body must be a Buffer that contains the metadata JSON.
    const body = (init as RequestInit).body as Buffer
    expect(Buffer.isBuffer(body)).toBe(true)
    expect(body.toString('utf8')).toContain('"name":"arkiv.zip"')
    expect(body.toString('utf8')).toContain('"parents":["folder-1"]')
  })

  it('throws with Drive error body when upload fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('quota exceeded', { status: 403 })
    )
    await expect(
      uploadFile('at', 'folder', 'a.zip', new Uint8Array(1).buffer)
    ).rejects.toThrow(/403/)
  })
})
