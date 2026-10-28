import { describe, expect, test } from 'bun:test';
import { collectTurnEffects, newTurnAccumulator, resetTurnAccumulator, turnContextPrefix, turnEndPayload } from './canvas-turn.mjs';
import { SYSTEM_PROMPT } from './full-control-loader.mjs';

const production = {
  proposalId: 'sp-1', kind: 'studio_production', projectId: 'studio-p1', summary: '基于真实项目详情',
  warnings: [], source: { projectId: 'studio-p1', stageRevision: 7, shotId: 'shot-1', candidatesDigest: 'digest-1' },
  nextActions: [{ kind: 'take_compare', shotId: 'shot-1', candidateId: 'candidate-1', label: '人工比较候选', section: 'shots', requiresHuman: true }],
};

describe('Studio 人工生产提案', () => {
  test('收集到独立 productionProposals，不混入 Canvas generation.propose，不写画布变更', () => {
    const turn = resetTurnAccumulator(newTurnAccumulator(), 4);
    collectTurnEffects(turn, 'studio.review.propose', production);
    expect(turn.productionProposals).toEqual([production]);
    expect(turn.proposals).toEqual([]);
    expect(turn.revisionAfter).toBe(0);
    const end = turnEndPayload(turn, { turnId: 'turn-1', reply: '请人工复核', toolCalls: [], change: null,
      proposals: [], error: null, errorReason: null, cancelled: false });
    expect(end.type).toBe('turn_end');
    expect(end.studioProposals).toEqual([production]);
    expect(end.proposals).toEqual([]);
    resetTurnAccumulator(turn, 5);
    expect(turn.productionProposals).toEqual([]);
  });

  test('模型上下文标注 Studio 项目是只读显式引用', () => {
    const prefix = turnContextPrefix({ canvasId: 'canvas-1', references: [{ kind: 'studio_project', id: 'studio-p1' }] });
    expect(prefix).toContain('已引用 Studio 项目（只读）: studio-p1');
  });

  test('提示词要求先读真实项目和成本，只提出人工动作，禁止宣称执行结果', () => {
    for (const text of ['studio_project_get', 'studio_estimate_preview', 'studio_review_propose', '人工', '不能确认阶段', '不能启动渲染', '不能选择候选', '不能宣称已扣费']) {
      expect(SYSTEM_PROMPT).toContain(text);
    }
  });
});
