import { describe, expect, it } from 'vitest';
import { validateEducationAiJob, validateTeacherLessonCandidate } from './education-workflows';

const sourceRef = { type: 'material_page' as const, session_id: 'classroom_1', material_id: 'material_1', page_index: 0 };

describe('education host workflow contracts', () => {
  it('validates private AI jobs inside the example boundary', () => {
    expect(validateEducationAiJob({
      schema_version: 'inkloop.classroom.v1', job_id: 'job_1', classroom_id: 'classroom_1', kind: 'practice', status: 'completed',
      evidence: { checkpoint_id: 'cp_1', classroom_id: 'classroom_1', sequence_start: 1, sequence_end: 1, time_start_ms: 0, time_end_ms: 1, source_refs: [sourceRef] },
      result: { execution_mode: 'real', title: '练习', sections: [{ section_id: 's1', content: '题目', source_refs: [sourceRef] }], review_status: 'kept' },
      created_at: 'now', updated_at: 'now',
    })).toEqual([]);
  });

  it('rejects incomplete AI jobs and teacher review candidates', () => {
    expect(validateEducationAiJob({
      job_id: 'job_1', classroom_id: 'classroom_1', kind: 'practice', status: 'completed',
      evidence: { checkpoint_id: 'cp_1', classroom_id: 'classroom_1', sequence_start: 2, sequence_end: 1, time_start_ms: 2, time_end_ms: 1, source_refs: [] },
      result: { execution_mode: 'deterministic_fallback', title: '练习', sections: [], review_status: 'edited' }, created_at: 'now', updated_at: 'now',
    }).map((item) => item.path)).toEqual(expect.arrayContaining(['job.evidence.sequence_end', 'job.evidence.time_end_ms', 'job.evidence.source_refs', 'job.result.sections', 'job.result.fallback_reason', 'job.result.original_result']));
    expect(validateTeacherLessonCandidate({ candidate_id: 'c1', classroom_id: 'classroom_1', generation_id: 'g1', kind: 'formula', order: 1, content: 'x=1', confidence: 2, source_refs: [], review_status: 'edited' }).map((item) => item.path)).toEqual(expect.arrayContaining(['candidate.confidence', 'candidate.source_refs', 'candidate.original_content']));
  });
});
