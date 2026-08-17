import { useGenerationDraft } from '../generation-draft';

describe('generation-draft store', () => {
  beforeEach(() => {
    useGenerationDraft.setState({ draft: null });
  });

  it('初始无草稿，consume 返回 null', () => {
    expect(useGenerationDraft.getState().consumeDraft()).toBeNull();
  });

  it('setDraft 后 consumeDraft 取出并清空（一次性）', () => {
    useGenerationDraft.getState().setDraft({ prompt: '一只在月球上的猫' });
    expect(useGenerationDraft.getState().consumeDraft()).toEqual({ prompt: '一只在月球上的猫' });
    // 第二次消费应为 null
    expect(useGenerationDraft.getState().consumeDraft()).toBeNull();
    expect(useGenerationDraft.getState().draft).toBeNull();
  });

  it('后一次 setDraft 覆盖前一次', () => {
    useGenerationDraft.getState().setDraft({ prompt: 'a' });
    useGenerationDraft.getState().setDraft({ prompt: 'b' });
    expect(useGenerationDraft.getState().consumeDraft()?.prompt).toBe('b');
  });
});
