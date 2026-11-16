import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { migrate, one, query, pool } from '../server/db.js';
import { generateCampaign, interviewerTurn, speech, transcribe, analyzeInterview, synthesizeResearch, askResearch, type Message } from '../server/ai.js';

const evidence: any = { verifiedAt: new Date().toISOString(), scope: 'Live Groq SDK and PostgreSQL integration; generated WAV fixtures stand in for microphone input.', checks: [] };
try {
  await migrate();
  const resume = process.argv.includes('--resume');
  if (resume) Object.assign(evidence, JSON.parse(await readFile('evidence/agents-live.json', 'utf8')), { verifiedAt: new Date().toISOString(), error: undefined });
  const workspace = resume ? await one<any>('SELECT * FROM workspaces WHERE id=$1', [evidence.workspaceId]) : await one<any>(`INSERT INTO workspaces(name,is_guest,expires_at) VALUES('Automated live agent verification',true,now()+interval '1 day') RETURNING id`);
  evidence.workspaceId = workspace.id;
  let campaign: any;
  if (resume) campaign = await one('SELECT * FROM campaigns WHERE id=$1', [evidence.campaignId]);
  else {
    const content = await generateCampaign(workspace.id, 'Understand remote workers\' task management frustrations, manual status updates, and whether a simple shared view of priorities would help.');
    evidence.checks.push({ name: 'Research Strategist', passed: content.questions.length >= 3, questionCount: content.questions.length });
    campaign = await one<any>(`INSERT INTO campaigns(workspace_id,name,description,audience,objectives,assumptions,questions,strategy,success_criteria,status,public_token,duration_minutes,max_participants) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,5,4) RETURNING *`, [workspace.id, content.name, content.description, content.audience, JSON.stringify(content.objectives), JSON.stringify(content.assumptions), JSON.stringify(content.questions), content.strategy, JSON.stringify(content.successCriteria), randomBytes(24).toString('hex')]);
  }
  evidence.campaignId = campaign.id;
  const fixtures = [
    ['I spend an hour every Friday copying tasks between Slack and a spreadsheet. Last week I missed a deadline because the project status was out of date.', 'I want one view of priorities that updates automatically. I would try a tool for a week before paying, and my main concern is setup time.'],
    ['I lose focus when I switch between task tools. I work alone and already know my priorities, so I do not need another shared dashboard.', 'My biggest problem is getting interrupted by Slack notifications. I would rather pay for a quiet focus timer than automate status updates.'],
  ];
  const followups: string[] = [];
  for (const [index, answers] of fixtures.entries()) {
    const existing = resume ? await one<any>('SELECT * FROM interviews WHERE campaign_id=$1 AND participant_label=$2', [campaign.id, `Live audio fixture ${index + 1}`]) : null;
    const interview = existing || await one<any>(`INSERT INTO interviews(campaign_id,workspace_id,participant_label,token_hash,status) VALUES($1,$2,$3,$4,'active') RETURNING *`, [campaign.id, workspace.id, `Live audio fixture ${index + 1}`, randomBytes(32).toString('hex')]);
    const history: Message[] = await query('SELECT * FROM messages WHERE interview_id=$1 ORDER BY created_at,id', [interview.id]);
    if (interview.status === 'completed') continue;
    if (!history.length) {
      const initial = await interviewerTurn({ ...interview, campaign }, history);
      history.push((await one<Message>('INSERT INTO messages(interview_id,role,text) VALUES($1,\'assistant\',$2) RETURNING *', [interview.id, initial.text]))!);
    }
    if (index === 0 && !resume) {
      const audio = await speech(history[0].text, workspace.id);
      evidence.checks.push({ name: 'Groq generated interviewer speech', passed: audio.segments.length > 0 && audio.segments.every(s => s.subarray(0, 4).toString() === 'RIFF'), segments: audio.segments.length, bytes: audio.segments.reduce((n, s) => n + s.length, 0) });
    }
    if (history.at(-1)?.role === 'user') {
      const next = await interviewerTurn({ ...interview, campaign }, history, history.at(-1)!.text);
      followups.push(next.text);
      history.push((await one<Message>('INSERT INTO messages(interview_id,role,text) VALUES($1,\'assistant\',$2) RETURNING *', [interview.id, next.text]))!);
    }
    const answered = history.filter(m => m.role === 'user').length;
    for (const [answerIndex, answer] of answers.entries()) {
      if (answerIndex < answered) continue;
      const audio = await speech(answer, workspace.id);
      const transcript = await transcribe(audio.segments[0], 'audio/wav', workspace.id);
      evidence.checks.push({ name: `Participant ${index + 1} actual WAV transcription`, passed: transcript.text.length > 20, transcript: transcript.text });
      history.push((await one<Message>('INSERT INTO messages(interview_id,role,text) VALUES($1,\'user\',$2) RETURNING *', [interview.id, transcript.text]))!);
      const next = await interviewerTurn({ ...interview, campaign }, history, transcript.text);
      followups.push(next.text);
      history.push((await one<Message>('INSERT INTO messages(interview_id,role,text) VALUES($1,\'assistant\',$2) RETURNING *', [interview.id, next.text]))!);
    }
    await query(`UPDATE interviews SET status='completed',completed_at=now(),duration_seconds=90,turn_count=$2 WHERE id=$1`, [interview.id, answers.length]);
    const analysis = await analyzeInterview(interview.id);
    evidence.checks.push({ name: `Participant ${index + 1} grounded analysis`, passed: Boolean(analysis?.verified && analysis.findings.length), findings: analysis?.findings.length });
  }
  const allFollowups = await query<any>(`SELECT m.text FROM messages m JOIN interviews i ON i.id=m.interview_id WHERE i.campaign_id=$1 AND m.role='assistant' ORDER BY m.created_at`, [campaign.id]);
  evidence.checks.push({ name: 'Independent personalized follow-ups', passed: new Set(allFollowups.map(r => r.text)).size === allFollowups.length, outputs: allFollowups.map(r => r.text) });
  const intelligence = await synthesizeResearch(campaign.id);
  evidence.checks.push({ name: 'Combined intelligence and independent verification', passed: intelligence?.participantCount === 2 && intelligence.themes.length > 0 && intelligence.verification.exactQuotesVerified, participantCount: intelligence?.participantCount, themes: intelligence?.themes.length, recommendations: intelligence?.recommendations.length });
  const answer = await askResearch(workspace.id, 'What are the biggest frustrations and what should we investigate next?', campaign.id);
  evidence.checks.push({ name: 'Grounded research assistant', passed: answer.evidence.length > 0, evidenceReferences: answer.evidence.length, answer: answer.answer });
  const runs = await query<any>('SELECT agent,status,count(*)::int AS executions FROM agent_runs WHERE workspace_id=$1 GROUP BY agent,status ORDER BY agent', [workspace.id]);
  evidence.agentExecutions = runs;
  evidence.passed = evidence.checks.every((c: any) => c.passed) && runs.filter(r => r.status === 'completed').length === 7;
} catch (error: any) {
  evidence.passed = false;
  evidence.error = { code: error.code || 'INTEGRATION_ERROR', message: error.message?.slice(0, 600) };
} finally {
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/agents-live.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: evidence.passed, checks: evidence.checks.length, failed: evidence.checks.filter((c: any) => !c.passed).map((c: any) => c.name), error: evidence.error || null }));
  await pool.end();
  if (!evidence.passed) process.exitCode = 1;
}
