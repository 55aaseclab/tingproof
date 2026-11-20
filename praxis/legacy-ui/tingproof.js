import { t, mountLanguageControls } from './i18n.js';
import { createAppTransport, populateContexts } from './app-transport.js';

const $ = id => document.getElementById(id);
function setText(node, text) {
  if (Array.isArray(text)) {
    [node.dataset.en, node.dataset.zh] = text;
    node.textContent = t(...text);
  } else {
    delete node.dataset.en;
    delete node.dataset.zh;
    node.textContent = text;
  }
}
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) setText(node, text); if (className) node.className = className; return node; };
const state = { assignment: null, draft: new Map(), dirty: false, stale: false, epoch: 0, conflicts: new Set() };
function notice(message = '') { setText($('notice'), message); }
function offerRetry(message, action) {
  const retry = element('button', ["Retry", "重新读取"]); retry.type = 'button';
  retry.addEventListener('click', () => { retry.disabled = true; void action(); });
  $('content').replaceChildren(element('p', message, 'empty'), retry);
}
function clearAssignment(message) {
  state.epoch++; state.draft.clear(); state.conflicts.clear();
  state.assignment = null; state.dirty = false; state.stale = false;
  setText($('heading'), ["Proofreading tasks", "听校任务"]);
  $('main').setAttribute('aria-busy', 'false'); notice();
  $('content').replaceChildren(element('p', message, 'empty'));
}
const client = createAppTransport('tingproof', {
  onStatus: text => { $('connection').textContent = text; },
  onChange: () => { if (state.dirty) { state.stale = true; notice(["This task changed. Review the latest version before saving your draft.", "任务有新变化，你的校正草稿已保留。请查看最新版本后再提交。"]); } else void load(false); },
  onRevoked: () => { populateContexts([]); clearAssignment(["Access changed. Reopen the task.", "访问权限已变化，请重新打开任务。"]); },
});
const invoke = client.invoke;
async function renderAssignments() {
  const epoch = state.epoch;
  const result = await invoke('list_assignments'); const assignments = result.assignments || result.items || [];
  if (state.epoch !== epoch) return;
  $('content').replaceChildren();
  if (!assignments.length) return $('content').append(element('p', ["No tasks are assigned to you.", "目前没有分配给你的任务。"], 'empty'));
  for (const assignment of assignments) {
    const button = element('button', undefined, 'assignment-link'); button.type = 'button'; button.append(element('strong', assignment.title || ["Proofreading tasks", "听校任务"]), element('p', assignment.status === 'revoked' ? ["Closed", "已结束"] : ["Awaiting review", "待校正"], 'meta'));
    button.addEventListener('click', () => openAssignment(assignment.id)); $('content').append(button);
  }
}
async function openAssignment(id, { preserve = false } = {}) {
  const epoch = ++state.epoch; $('main').setAttribute('aria-busy', 'true');
  try {
    const result = await invoke('get_assignment', { resourceId: id });
    if (state.epoch !== epoch) return;
    preserve ||= state.dirty && state.assignment?.assignment.id === id;
    state.assignment = result;
    if (!preserve) { state.draft.clear(); state.dirty = false; } state.stale = false; state.conflicts.clear();
    $('content').replaceChildren(); setText($('heading'), result.assignment.title || ["Proofreading tasks", "听校任务"]);
    const canSubmit = client.context?.apps.find(app => app.id === 'tingproof')?.actions.includes('submit');
    for (const segment of result.segments) {
      const section = element('section', undefined, 'segment'), cue = segment.cueNo ?? result.segments.indexOf(segment) + 1, label = element('label', [`Segment ${cue}`, `第 ${cue} 段`]); label.htmlFor = `segment-${segment.segmentId}`;
      const field = element('textarea'); field.id = label.htmlFor; field.value = state.draft.get(segment.segmentId) ?? segment.correctedText ?? segment.originalText;
      field.readOnly = !canSubmit;
      if (canSubmit) field.addEventListener('input', () => { state.draft.set(segment.segmentId, field.value); state.dirty = true; }); section.append(label, element('p', segment.originalText), field); $('content').append(section);
      const latest = segment.correctedText ?? segment.originalText;
      if (preserve && state.draft.has(segment.segmentId) && state.draft.get(segment.segmentId) !== latest) {
        state.conflicts.add(segment.segmentId); state.stale = true;
        section.insertBefore(element('p', [`Latest correction: ${latest}`, `最新校正：${latest}`], 'meta'), field);
        const decisions = element('div', undefined, 'section-tabs');
        for (const [label, keepDraft] of [[["Use latest correction", "采用最新校正"], false], [["Keep my draft", "保留我的校正"], true]]) {
          const button = element('button', label); button.type = 'button'; button.addEventListener('click', () => {
            if (!keepDraft) { field.value = latest; state.draft.delete(segment.segmentId); }
            state.conflicts.delete(segment.segmentId); state.stale = state.conflicts.size > 0; state.dirty = state.draft.size > 0; decisions.remove();
            notice(state.stale ? ["Review the remaining differences.", "请处理其余校正差异。"] : ["All differences have been resolved. You can save now.", "校正差异已处理，可以保存。"]);
          }); decisions.append(button);
        }
        section.append(decisions);
      }
    }
    if (client.context?.apps.find(app => app.id === 'tingproof')?.actions.includes('submit')) {
      const save = element('button', ["Save corrections", "保存校正"], 'primary'); save.type = 'button'; save.addEventListener('click', async () => {
        if (!state.draft.size) return notice(["No changes to save.", "没有需要保存的修改。"]); if (state.stale) return notice(["Review the latest version. Your draft is preserved.", "请先查看最新版本，你的草稿已保留。"]);
        const saving = ++state.epoch; $('main').setAttribute('aria-busy', 'true');
        save.disabled = true; setText(save, ["Saving…", "正在保存…"]); refresh.disabled = true;
        const fields = $('content').querySelectorAll('textarea');
        for (const field of fields) field.readOnly = true;
        try {
          await invoke('submit_corrections', { resourceId: id, expectedRevision: String(state.assignment.revision), idempotencyKey: crypto.randomUUID(), input: { corrections: [...state.draft].map(([segmentId, correctedText]) => ({ segmentId, correctedText })) } });
          if (state.epoch !== saving) return;
          state.dirty = false; state.draft.clear();
          if (await openAssignment(id)) notice(["Saved", "已保存"]);
        } catch (error) {
          if (state.epoch !== saving) return;
          if (error.status === 401) { clearAssignment(error.message); return; }
          if (!error.status || error.status === 409 || error.code === 'OUTCOME_UNKNOWN') {
            state.stale = true; notice(["Check the latest version to confirm the outcome before saving again.", "请先查看最新版本，确认保存结果后再提交。"]);
          } else notice(error.message);
        } finally {
          if (saving === state.epoch) $('main').setAttribute('aria-busy', 'false');
          if (save.isConnected) {
            for (const field of fields) field.readOnly = false;
            save.disabled = false; setText(save, ["Save corrections", "保存校正"]); refresh.disabled = false;
          }
        }
      }); $('content').append(save);
    }
    const refresh = element('button', ["Review latest version", "查看最新版本"], 'primary'); refresh.type = 'button'; refresh.addEventListener('click', () => openAssignment(id, { preserve: true })); $('content').append(refresh);
    if (state.stale) notice(["Compare each change with your draft and choose which text to keep.", "请比较最新校正和你的草稿，并选择保留的内容。"]);
    return true;
  } catch (error) {
    if (state.epoch !== epoch) return;
    if ([401, 403, 404].includes(error.status)) clearAssignment(error.message);
    else notice(error.message);
  }
  finally { if (state.epoch === epoch) $('main').setAttribute('aria-busy', 'false'); }
}
async function load(reconnect = true) {
  if (!client.context) return;
  const current = ++state.epoch; $('main').setAttribute('aria-busy', 'true'); notice();
  try {
    if (reconnect) client.subscribe();
    if (state.assignment) await openAssignment(state.assignment.assignment.id); else { setText($('heading'), ["Proofreading tasks", "听校任务"]); await renderAssignments(); }
  } catch (error) {
    if (state.epoch !== current) return;
    if ([401, 403].includes(error.status)) { client.disconnect(); populateContexts([]); clearAssignment(error.message); }
    else offerRetry(["Could not load proofreading tasks.", "暂时无法读取听校任务。"], () => load(false));
  } finally { if (state.epoch === current) $('main').setAttribute('aria-busy', 'false'); }
}
async function initialize() {
  $('main').setAttribute('aria-busy', 'true');
  $('content').replaceChildren(element('p', ["Loading proofreading tasks…", "正在读取听校任务…"], 'empty'));
  try {
    const result = await client.initialize(); populateContexts(result.contexts);
    if (!result.authorized) return $('content').replaceChildren(element('p', ["No content is available.", "暂无可显示的内容。"], 'empty'));
    if (!result.contexts.length) return $('content').replaceChildren(element('p', ["No accessible proofreading tasks.", "目前没有可访问的听校任务。"], 'empty'));
    await load();
  } catch (error) {
    if ([401, 403].includes(error.status)) clearAssignment(error.message);
    else offerRetry(["Could not connect to TingProof.", "暂时无法连接听校。"], initialize);
  }
  finally { $('main').setAttribute('aria-busy', 'false'); }
}
document.querySelector('#navigation button').addEventListener('click', () => {
  if (state.dirty) { notice(["Save your corrections before continuing.", "你有尚未保存的校正，请先保存。"]); return; }
  state.epoch++; state.assignment = null; state.draft.clear(); state.conflicts.clear(); state.stale = false; void load(false);
});
$('space').addEventListener('change', () => {
  if (state.dirty) { $('space').value = client.context?.id || ''; notice(["Save your corrections before continuing.", "你有尚未保存的校正，请先保存。"]); return; }
  state.epoch++; state.assignment = null; state.draft.clear(); state.conflicts.clear(); state.stale = false;
  client.selectContext($('space').value); $('content').replaceChildren(); void load();
});
addEventListener('offline', () => { setText($('connection'), ["Offline", "离线"]); });
addEventListener('online', () => { if (!state.dirty && client.context) void load(); });
addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
mountLanguageControls();
void initialize();
