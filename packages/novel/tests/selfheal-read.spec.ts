import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class FeishuError extends Error {
    readonly kind: string
    readonly code?: number
    constructor(kind: string, message: string, code?: number) {
      super(message)
      this.kind = kind
      this.code = code
    }
  }
  return {
    FeishuError,
    listRecords: vi.fn(),
  }
})

vi.mock('@unwr/feishu', () => ({
  FeishuError: mocks.FeishuError,
  hintFor: () => '目标资源不可用',
  configureLark: vi.fn(),
  base: {
    listRecords: mocks.listRecords,
    listTables: vi.fn(async () => ({ tables: [] })),
  },
}))

import { listRecordsWithSelfHeal } from '../src/domain/selfheal.js'

describe('listRecordsWithSelfHeal', () => {
  it('在记录短暂不可见后自动重试并返回读取结果', async () => {
    const matrix = {
      data: [['标题']],
      fields: ['title'],
      field_id_list: ['fld1'],
      field_type_list: [1],
      record_id_list: ['rec1'],
    }
    mocks.listRecords
      .mockRejectedValueOnce(new mocks.FeishuError('not_found', '目标资源暂时不可见'))
      .mockResolvedValueOnce(matrix)

    const events: string[] = []
    const result = await listRecordsWithSelfHeal(
      'b',
      'memory',
      { limit: 1 },
      undefined,
      (event) => { events.push(event.message) },
    )

    expect(result).toBe(matrix)
    expect(mocks.listRecords).toHaveBeenCalledTimes(2)
    expect(events).toEqual([
      '读取 memory 遇 not_found（新库收敛中），退避重试 1/3……',
    ])
  })

  it('不可自愈的错误不被伪装成重试成功', async () => {
    mocks.listRecords.mockReset()
    mocks.listRecords.mockRejectedValue(new mocks.FeishuError('permission_denied', '无权限'))

    await expect(listRecordsWithSelfHeal('b', 'memory', {}, undefined))
      .rejects.toThrow('读取 memory 失败：permission_denied — 无权限；目标资源不可用')
    expect(mocks.listRecords).toHaveBeenCalledTimes(1)
  })
})
