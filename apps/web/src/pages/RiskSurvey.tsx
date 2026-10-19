import { useEffect, useRef, useState } from 'react';
import { api, describe, intentDone, intentKey } from '../api';
import { formatDateTime, riskLabel } from '../format';
import type { Allocation } from '../ui';
import { AlertAction, AllocationSummary, Choice, ErrorAlert, Loading, OtpCodeInput, OtpInbox, PageTitle, Panel, ResendCode, choiceInput, useLoad } from '../ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

interface Questionnaire { version: string; questions: Array<{ id: string; text: string; options: Array<{ id: string; text: string }> }> }
interface Draft { id: string; score: number; category: string; maxProductRisk: number; allocation: Allocation; expiresAt: string; expectedCurrentProfileVersion: number }
interface Challenge { challengeId: string; expiresAt: string }

const surveyErrors = { '404': 'Bạn cần đồng ý dịch vụ trước khi làm khảo sát rủi ro. Mở mục Lời mời dịch vụ.' };

/** UC02: ten server-owned questions, server-scored draft preview, OTP-confirmed profile. */
export function RiskSurvey() {
  const questionnaire = useLoad(signal => api<Questionnaire>('/risk-questionnaires/current', { signal }), []);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [step, setStep] = useState(0);
  const questionHeading = useRef<HTMLParagraphElement>(null);
  const stepMoved = useRef(false);
  useEffect(() => { if (stepMoved.current) questionHeading.current?.focus(); }, [step]);
  const goTo = (target: number) => { stepMoved.current = true; setStep(target); };

  const questions = questionnaire.data?.questions ?? [];
  const answered = questions.filter(question => answers[question.id]).length;

  const choose = (questionId: string, optionId: string) => {
    setAnswers(previous => ({ ...previous, [questionId]: optionId }));
    // Any change invalidates the preview and its OTP: a new preview is required.
    setDraft(null); setChallenge(null); setCode(''); setFailure(null);
  };

  const guarded = async (work: () => Promise<void>, overrides: Record<string, string> = {}) => {
    setBusy(true); setFailure(null);
    try { await work(); } catch (error) { setFailure(describe(error, overrides)); } finally { setBusy(false); }
  };

  const preview = () => {
    if (!questionnaire.data) return Promise.resolve();
    if (answered < questions.length) { setFailure(`Vui lòng trả lời đủ ${questions.length} câu trước khi xem kết quả dự kiến.`); return Promise.resolve(); }
    const payload = questions.map(question => ({ questionId: question.id, optionId: answers[question.id]! }));
    const version = questionnaire.data.version;
    return guarded(async () => {
      setDraft(await api<Draft>('/me/risk-assessments', { key: intentKey('risk-draft', JSON.stringify([version, payload])),
        body: { questionnaireVersion: version, answers: payload } }));
      setChallenge(null); setCode('');
    }, surveyErrors);
  };

  const sendOtp = () => guarded(async () => {
    if (!draft) return;
    setCode('');
    setChallenge(await api<Challenge>('/otp/challenges', { body: { purpose: 'RISK_PROFILE_CONFIRM', operationId: draft.id } }));
  });

  const confirm = () => guarded(async () => {
    if (!draft || !challenge) return;
    if (!/^\d{6}$/.test(code)) { setFailure('Mã OTP gồm đúng 6 chữ số.'); return; }
    const name = `risk-confirm-${draft.id}`;
    await api(`/me/risk-assessments/${draft.id}/confirm`, { key: intentKey(name, `${challenge.challengeId}:${code}`),
      body: { challengeId: challenge.challengeId, code, expectedCurrentProfileVersion: draft.expectedCurrentProfileVersion } });
    intentDone(name);
    setConfirmed(true);
  });

  if (confirmed) {
    return (
      <>
        <PageTitle title="Khảo sát rủi ro" />
        <Panel title="Hoàn tất" tone="success" focusOnMount>
          <p className="font-semibold text-ok">Đã xác nhận hồ sơ rủi ro</p>
          <p>Hồ sơ mới có hiệu lực ngay. Mở mục Hồ sơ rủi ro để xem điểm, ngày hết hạn và lịch sử.</p>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageTitle title="Khảo sát rủi ro" hint="Trả lời mười câu hỏi. Điểm và mức rủi ro do hệ thống tính; kết quả dự kiến chỉ có hiệu lực sau khi bạn xác nhận bằng OTP." />
      {questionnaire.loading ? <Loading skeleton /> : null}
      {questionnaire.error ? <ErrorAlert>{describe(questionnaire.error, surveyErrors)} <AlertAction onClick={questionnaire.reload}>Thử lại</AlertAction></ErrorAlert> : null}
      {questionnaire.data ? (
        <>
          <div className="sticky top-0 z-10 mb-4 flex items-center gap-3 bg-background py-2.5 text-[0.9rem] font-semibold">
            <Progress className="flex-1" aria-label="Tiến độ khảo sát" aria-valuemin={0} aria-valuemax={questions.length} aria-valuenow={answered} value={answered} max={questions.length} />
            <span className="tabular-nums">{answered}/{questions.length} câu</span>
          </div>
          {questions[step] ? (() => {
            const question = questions[step]!;
            const last = step === questions.length - 1;
            const isAnswered = Boolean(answers[question.id]);
            return (
              <div key={question.id} className="mb-5 rounded-xl border bg-card p-[18px] shadow-sm">
                <p className="mb-1.5 text-[0.82rem] font-semibold text-accent-foreground tabular-nums">Câu {step + 1}/{questions.length}</p>
                <p id={`q-${question.id}`} ref={questionHeading} tabIndex={-1} className="mb-3.5 text-[1.12rem] leading-snug font-semibold outline-none">{question.text}</p>
                <div role="radiogroup" aria-labelledby={`q-${question.id}`}>
                  {question.options.map(option => (
                    <Choice key={option.id}>
                      <input type="radio" className={choiceInput} name={`q-${question.id}`} value={option.id}
                        checked={answers[question.id] === option.id} onChange={() => choose(question.id, option.id)} />
                      <span>{option.text}</span>
                    </Choice>
                  ))}
                </div>
                <div className="mt-4 flex justify-between gap-3 *:max-sm:flex-1 *:sm:min-w-[132px] *:only:ml-auto">
                  <Button type="button" variant="outline" onClick={() => goTo(step - 1)} disabled={step === 0 || busy}>Câu trước</Button>
                  {last
                    ? <Button type="button" onClick={() => void preview()} disabled={!isAnswered || busy}>Xem kết quả dự kiến</Button>
                    : <Button type="button" onClick={() => goTo(step + 1)} disabled={!isAnswered}>Câu tiếp</Button>}
                </div>
              </div>
            );
          })() : null}
          {busy ? <Loading label="Đang xử lý…" /> : null}
          {failure ? <ErrorAlert>{failure}</ErrorAlert> : null}
          {draft ? (
            <Panel title="Kết quả dự kiến" tone="preview" focusOnMount>
              <p className="mb-1 text-[1.9rem] leading-tight font-bold">{riskLabel(draft.category)}</p>
              <p className="mb-2 flex items-baseline text-[0.9rem] font-medium text-muted-foreground">
                <span>Điểm: </span>
                <strong data-testid="risk-score" className="ml-1.5 text-[1.6rem] leading-none font-bold text-foreground tabular-nums">{draft.score}</strong>
              </p>
              <AllocationSummary maxProductRisk={draft.maxProductRisk} allocation={draft.allocation} />
              <p><Badge variant="wait">Bản nháp, chưa có hiệu lực</Badge></p>
              <p className="text-muted-foreground">Bản xem trước dùng được đến {formatDateTime(draft.expiresAt)}.</p>
              <Button type="button" onClick={() => void sendOtp()} disabled={busy}>Gửi mã OTP</Button>
              {challenge ? (
                <div className="mt-4 border-t pt-4">
                  <OtpInbox key={`inbox-${challenge.challengeId}`} challengeId={challenge.challengeId} />
                  <OtpCodeInput key={challenge.challengeId} onChange={setCode} disabled={busy} />
                  <ResendCode key={`resend-${challenge.challengeId}`} onResend={() => void sendOtp()} busy={busy} />
                  <Button type="button" onClick={() => void confirm()} disabled={busy || code.length < 6}>Xác nhận hồ sơ rủi ro</Button>
                </div>
              ) : null}
            </Panel>
          ) : null}
        </>
      ) : null}
    </>
  );
}
