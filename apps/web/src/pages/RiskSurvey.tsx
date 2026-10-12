import { useEffect, useRef, useState } from 'react';
import { api, describe, intentDone, intentKey } from '../api';
import { formatDateTime, riskLabel } from '../format';
import type { Allocation } from '../ui';
import { AllocationSummary, ErrorAlert, Loading, OtpCodeInput, OtpInbox, PageTitle, Panel, ResendCode, useLoad } from '../ui';

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
        <Panel title="Hoàn tất" className="success">
          <p className="success-line">Đã xác nhận hồ sơ rủi ro</p>
          <p>Hồ sơ mới có hiệu lực ngay. Mở mục Hồ sơ rủi ro để xem điểm, ngày hết hạn và lịch sử.</p>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageTitle title="Khảo sát rủi ro" hint="Trả lời mười câu hỏi. Điểm và mức rủi ro do hệ thống tính; kết quả dự kiến chỉ có hiệu lực sau khi bạn xác nhận bằng OTP." />
      {questionnaire.loading ? <Loading /> : null}
      {questionnaire.error ? <ErrorAlert>{describe(questionnaire.error, surveyErrors)} <button type="button" className="link" onClick={questionnaire.reload}>Thử lại</button></ErrorAlert> : null}
      {questionnaire.data ? (
        <>
          <div className="progress">
            <div role="progressbar" aria-label="Tiến độ khảo sát" aria-valuemin={0} aria-valuemax={questions.length} aria-valuenow={answered}>
              <span style={{ width: `${(answered / questions.length) * 100}%` }} />
            </div>
            <span>{answered}/{questions.length} câu</span>
          </div>
          {questions[step] ? (() => {
            const question = questions[step]!;
            const last = step === questions.length - 1;
            const isAnswered = Boolean(answers[question.id]);
            return (
              <div key={question.id} className="question">
                <p className="question-step">Câu {step + 1}/{questions.length}</p>
                <p id={`q-${question.id}`} ref={questionHeading} tabIndex={-1} className="question-text">{question.text}</p>
                <div role="radiogroup" aria-labelledby={`q-${question.id}`} className="options">
                  {question.options.map(option => (
                    <label key={option.id} className="choice">
                      <input type="radio" name={`q-${question.id}`} value={option.id}
                        checked={answers[question.id] === option.id} onChange={() => choose(question.id, option.id)} />
                      <span>{option.text}</span>
                    </label>
                  ))}
                </div>
                <div className="wizard-nav">
                  <button type="button" className="secondary" onClick={() => goTo(step - 1)} disabled={step === 0 || busy}>Câu trước</button>
                  {last
                    ? <button type="button" onClick={() => void preview()} disabled={!isAnswered || busy}>Xem kết quả dự kiến</button>
                    : <button type="button" onClick={() => goTo(step + 1)} disabled={!isAnswered}>Câu tiếp</button>}
                </div>
              </div>
            );
          })() : null}
          {busy ? <Loading label="Đang xử lý…" /> : null}
          {failure ? <ErrorAlert>{failure}</ErrorAlert> : null}
          {draft ? (
            <Panel title="Kết quả dự kiến" className="preview">
              <p className="result-category">{riskLabel(draft.category)}</p>
              <p>Điểm: {draft.score}</p>
              <AllocationSummary maxProductRisk={draft.maxProductRisk} allocation={draft.allocation} />
              <p className="badge wait">Bản nháp, chưa có hiệu lực</p>
              <p className="hint">Bản xem trước dùng được đến {formatDateTime(draft.expiresAt)}.</p>
              <button type="button" onClick={() => void sendOtp()} disabled={busy}>Gửi mã OTP</button>
              {challenge ? (
                <div className="otp-step">
                  <OtpInbox key={`inbox-${challenge.challengeId}`} challengeId={challenge.challengeId} />
                  <OtpCodeInput key={challenge.challengeId} onChange={setCode} disabled={busy} />
                  <ResendCode key={`resend-${challenge.challengeId}`} onResend={() => void sendOtp()} busy={busy} />
                  <button type="button" onClick={() => void confirm()} disabled={busy || code.length < 6}>Xác nhận hồ sơ rủi ro</button>
                </div>
              ) : null}
            </Panel>
          ) : null}
        </>
      ) : null}
    </>
  );
}
