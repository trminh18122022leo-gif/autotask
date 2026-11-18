/**
 * Moodle quiz-attempt DOM fixtures (HTML only; no network, no real site, no credentials).
 *
 * IMPORTANT PROVENANCE NOTE: these fixtures are hand-written approximations of the markup produced by
 * Moodle's question renderers (div.que > .info + .content > .formulation > .qtext + .ablock). They were
 * NOT captured from a real Moodle instance. They are valid evidence for "the scanner handles this DOM
 * shape", and NOT evidence for "this works on lms.hust.edu.vn". Real Moodle sandbox validation is separate.
 *
 * Every fixture carries the expected EXTRACTION result (not an answer to the question) plus, for practice
 * items, a gold answer supplied by the tester, used only to benchmark the input pipeline.
 */
export interface ExpectedOption { text: string; media?: string[] }
export interface ExpectedQuestion {
  id: string; stableId: string; sourceType: string; kind: string; prompt: string;
  options?: ExpectedOption[]; required: boolean;
  media?: string[]; // question-scope media types (e.g. 'img', 'math')
  unsupported?: boolean; humanOnly?: boolean;
}
export interface GoldAnswer { optionTexts?: string[]; text?: string }
export interface MoodleFixture {
  name: string; category: string; html: string; url: string;
  expected: ExpectedQuestion[]; gold?: Record<string, GoldAnswer>;
}

const USAGE = 7001;
export const HOST = 'https://lms.hust.edu.vn';
export const attemptUrl = (page = 0) => `${HOST}/mod/quiz/attempt.php?attempt=11&cmid=55&page=${page}`;

/** Everything on a real quiz page that is NOT a question but contains form controls. */
export function chrome(opts: { next?: boolean; prev?: boolean; page?: number } = {}): { head: string; foot: string } {
  const head = `
  <nav class="navbar fixed-top navbar-expand moodle-has-zindex" aria-label="Site navigation">
    <img src="/theme/image.php/boost/core/1/moodlelogo" alt="Moodle logo">
    <form class="search-input-form" action="/search/index.php" method="get" role="search">
      <input type="search" name="q" placeholder="Search" aria-label="Search">
    </form>
    <input type="text" name="courseSearch" class="form-control" placeholder="Search courses" aria-label="Search courses">
    <div class="usermenu"><a href="/login/logout.php">Log out</a></div>
  </nav>
  <div id="page"><div id="region-main">
  <aside id="mod_quiz_navblock" class="block block_fake">
    <h5>Quiz navigation</h5>
    <div class="qn_buttons clearfix allquestionsononepage">
      <a class="qnbutton notyetanswered thispage" href="#q1">1</a>
      <a class="qnbutton notyetanswered" href="#q2">2</a>
    </div>
    <a class="endtestlink aalink" href="/mod/quiz/summary.php?attempt=11">Finish attempt ...</a>
    <input type="text" id="timerfield" value="" aria-label="timer">
    <select id="jump-to-activity" name="jump" aria-label="Jump to..."><option value="">Jump to...</option><option value="/mod/forum/view.php?id=3">Forum</option></select>
  </aside>
  <form action="/mod/quiz/processattempt.php" method="post" id="responseform">
  <input type="hidden" name="attempt" value="11"><input type="hidden" name="sesskey" value="abc">`;
  const foot = `
  <div class="submitbtns">
    ${opts.prev ? '<input type="submit" name="previous" value="Previous page" class="mod_quiz-prev-nav btn btn-secondary">' : ''}
    ${opts.next === false ? '' : '<input type="submit" name="next" value="Next page" class="mod_quiz-next-nav btn btn-primary">'}
  </div>
  </form></div></div>`;
  return { head, foot };
}

interface QueSpec {
  slot: number; type: string; qtext: string; ablock: string; extraClass?: string; info?: string; attachments?: string;
}
export function que(s: QueSpec): string {
  const u = USAGE;
  return `
  <div id="question-${u}-${s.slot}" class="que ${s.type} deferredfeedback notyetanswered ${s.extraClass || ''}">
    <div class="info">
      <h3 class="no">Question <span class="qno">${s.slot}</span></h3>
      <div class="state">Not yet answered</div>
      <div class="grade">Marked out of 1.00</div>
      <div class="questionflag editable">
        <input type="hidden" name="q${u}:${s.slot}_:flagged" value="0">
        <input type="checkbox" id="q${u}:${s.slot}_:flaggedcheckbox" name="q${u}:${s.slot}_:flagged" value="1" class="questionflagcheckbox">
        <label id="q${u}:${s.slot}_:flaggedlabel" for="q${u}:${s.slot}_:flaggedcheckbox">Flag question</label>
      </div>
    </div>
    <div class="content"><div class="formulation clearfix">
      <h4 class="accesshide">Question text</h4>
      <input type="hidden" name="q${u}:${s.slot}_:sequencecheck" value="1">
      <div class="qtext">${s.qtext}</div>
      <div class="ablock">${s.ablock}</div>${s.attachments || ''}
    </div></div>
  </div>`;
}

type Opt = { text: string; html?: string };
/** Radios/checkboxes. `legacy` uses Moodle 3.x <label for>, otherwise 4.x aria-labelledby layout. */
function choices(slot: number, multi: boolean, opts: Opt[], legacy = false, prompt = multi ? 'Select one or more:' : 'Select one:'): string {
  const u = USAGE;
  const rows = opts.map((o, i) => {
    const letter = String.fromCharCode(97 + i);
    const name = multi ? `q${u}:${slot}_choice${i}` : `q${u}:${slot}_answer`;
    const id = multi ? `q${u}:${slot}_choice${i}` : `q${u}:${slot}_answer${i}`;
    const inner = o.html ?? `<p>${o.text}</p>`;
    const cls = `r${i % 2}`;
    if (legacy) {
      return `<div class="${cls}"><input type="${multi ? 'checkbox' : 'radio'}" name="${name}" value="${multi ? 1 : i}" id="${id}"><label for="${id}" class="ml-1"><span class="answernumber">${letter}. </span>${inner}</label></div>`;
    }
    return `<div class="${cls} d-flex align-items-start"><input type="${multi ? 'checkbox' : 'radio'}" name="${name}" id="${id}" value="${multi ? 1 : i}" aria-labelledby="${id}_label" class="mt-1"><div class="d-flex w-auto" id="${id}_label" data-region="answer-label"><span class="answernumber">${letter}. </span><div class="flex-fill ml-1">${inner}</div></div></div>`;
  }).join('\n');
  const clear = multi ? '' : `<div class="qtype_multichoice_clearchoice sr-only"><input type="radio" name="q${u}:${slot}_clearchoice" id="q${u}:${slot}_clearchoice" value="-1" class="sr-only"><label for="q${u}:${slot}_clearchoice">Clear my choice</label></div>`;
  return `<div class="prompt">${prompt}</div><div class="answer">${rows}${clear}</div>`;
}
const textInput = (slot: number, extra = '') =>
  `<div class="answer"><span class="answer"><label class="sr-only" for="q${USAGE}:${slot}_answer">Answer</label><input type="text" name="q${USAGE}:${slot}_answer" id="q${USAGE}:${slot}_answer" size="30" class="form-control d-inline" ${extra}></span></div>`;

export const SLOT = {
  single: (opts?: { legacy?: boolean; slot?: number; shuffle?: number }): { html: string; exp: ExpectedQuestion; gold: GoldAnswer } => {
    const slot = opts?.slot ?? 1;
    const base = ['Paris', 'Lyon', 'Marseille', 'Nice'];
    const ordered = permute(base, opts?.shuffle);
    return {
      html: que({ slot, type: 'multichoice', qtext: '<p>Which city is the capital of France?</p>', ablock: choices(slot, false, ordered.map(t => ({ text: t })), opts?.legacy) }),
      exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:multichoice', kind: 'radio', prompt: 'Which city is the capital of France?', options: ordered.map(t => ({ text: t })), required: false },
      gold: { optionTexts: ['Paris'] }
    };
  },
  multi: (opts?: { slot?: number; shuffle?: number }) => {
    const slot = opts?.slot ?? 2; const base = ['2', '4', '5', '9']; const ordered = permute(base, opts?.shuffle);
    return {
      html: que({ slot, type: 'multichoice', qtext: '<p>Select all prime numbers.</p>', ablock: choices(slot, true, ordered.map(t => ({ text: t }))) }),
      exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:multichoice', kind: 'checkbox', prompt: 'Select all prime numbers.', options: ordered.map(t => ({ text: t })), required: false } as ExpectedQuestion,
      gold: { optionTexts: ['2', '5'] } as GoldAnswer
    };
  },
  truefalse: (slot = 3) => ({
    html: que({ slot, type: 'truefalse', qtext: '<p>The Earth orbits the Sun.</p>', ablock: `<div class="prompt">Select one:</div><div class="answer"><div class="r0"><input type="radio" name="q${USAGE}:${slot}_answer" value="1" id="q${USAGE}:${slot}_answer1" aria-labelledby="q${USAGE}:${slot}_answer1_label"><label id="q${USAGE}:${slot}_answer1_label" for="q${USAGE}:${slot}_answer1" class="ml-1">True</label></div><div class="r1"><input type="radio" name="q${USAGE}:${slot}_answer" value="0" id="q${USAGE}:${slot}_answer0" aria-labelledby="q${USAGE}:${slot}_answer0_label"><label id="q${USAGE}:${slot}_answer0_label" for="q${USAGE}:${slot}_answer0" class="ml-1">False</label></div></div>` }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:truefalse', kind: 'radio', prompt: 'The Earth orbits the Sun.', options: [{ text: 'True' }, { text: 'False' }], required: false } as ExpectedQuestion,
    gold: { optionTexts: ['True'] } as GoldAnswer
  }),
  shortanswer: (slot = 4) => ({
    html: que({ slot, type: 'shortanswer', qtext: '<p>Name the chemical symbol for gold.</p>', ablock: textInput(slot) }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:shortanswer', kind: 'text', prompt: 'Name the chemical symbol for gold.', required: false } as ExpectedQuestion,
    gold: { text: 'Au' } as GoldAnswer
  }),
  numerical: (slot = 5) => ({
    html: que({ slot, type: 'numerical', qtext: '<p>What is 6 × 7?</p>', ablock: textInput(slot) }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:numerical', kind: 'text', prompt: 'What is 6 × 7?', required: false } as ExpectedQuestion,
    gold: { text: '42' } as GoldAnswer
  }),
  essay: (slot = 6) => ({
    html: que({ slot, type: 'essay', qtext: '<p>Describe photosynthesis in two sentences.</p>', ablock: `<div class="answer"><div><textarea id="q${USAGE}:${slot}_answer" name="q${USAGE}:${slot}_answer" class="form-control" rows="15" cols="60" required></textarea></div><input type="hidden" name="q${USAGE}:${slot}_answerformat" value="1"></div>` }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:essay', kind: 'textarea', prompt: 'Describe photosynthesis in two sentences.', required: true } as ExpectedQuestion,
    gold: { text: 'Plants convert light into chemical energy. They release oxygen as a by-product.' } as GoldAnswer
  }),
  essayAtto: (slot = 7) => ({
    html: que({ slot, type: 'essay', qtext: '<p>State one cause of the French Revolution.</p>', ablock: `<div class="answer"><div class="editor_atto_wrap"><textarea id="q${USAGE}:${slot}_answer" name="q${USAGE}:${slot}_answer" style="display:none"></textarea><div class="editor_atto"><div id="q${USAGE}:${slot}_answereditable" class="editor_atto_content form-control" contenteditable="true" role="textbox" aria-multiline="true" style="min-height:80px"></div></div></div></div>` }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:essay', kind: 'textarea', prompt: 'State one cause of the French Revolution.', required: false } as ExpectedQuestion,
    gold: { text: 'Widespread food shortages and fiscal crisis.' } as GoldAnswer
  }),
  match: (slot = 8) => {
    const rows = [['Frog', 'Amphibian'], ['Eagle', 'Bird'], ['Shark', 'Fish']];
    const optsHtml = () => `<option value="0">Choose...</option><option value="1">Amphibian</option><option value="2">Bird</option><option value="3">Fish</option>`;
    const trs = rows.map((r, i) => `<tr class="r${i % 2}"><td class="text"><p>${r[0]}</p></td><td class="control"><label class="sr-only" for="menuq${USAGE}:${slot}_sub${i}">Answer ${i + 1}</label><select id="menuq${USAGE}:${slot}_sub${i}" name="q${USAGE}:${slot}_sub${i}" class="select custom-select menuq${USAGE}:${slot}_sub${i}">${optsHtml()}</select></td></tr>`).join('');
    const qtext = 'Match each animal with its class.';
    return {
      html: que({ slot, type: 'match', qtext: `<p>${qtext}</p>`, ablock: `<table class="answer"><tbody>${trs}</tbody></table>` }),
      exp: rows.map((r, i) => ({ id: `m${slot}_${i + 1}`, stableId: `question-${USAGE}-${slot}#${i + 1}`, sourceType: 'moodle:match', kind: 'select', prompt: `${qtext} :: ${r[0]}`, options: [{ text: 'Amphibian' }, { text: 'Bird' }, { text: 'Fish' }], required: false })) as ExpectedQuestion[],
      gold: Object.fromEntries(rows.map((r, i) => [`m${slot}_${i + 1}`, { optionTexts: [r[1]] }])) as Record<string, GoldAnswer>
    };
  },
  cloze: (slot = 9) => ({
    html: que({ slot, type: 'multianswer', qtext: `<p>The capital of Italy is <span class="subquestion"><label class="sr-only" for="q${USAGE}:${slot}_sub1_answer">Answer</label><input type="text" name="q${USAGE}:${slot}_sub1_answer" id="q${USAGE}:${slot}_sub1_answer" class="form-control d-inline" size="12"></span> and it has <span class="subquestion"><label class="sr-only" for="q${USAGE}:${slot}_sub2_answer">Answer</label><select name="q${USAGE}:${slot}_sub2_answer" id="q${USAGE}:${slot}_sub2_answer" class="select custom-select"><option value="">&nbsp;</option><option value="1">one</option><option value="2">two</option></select></span> famous river.</p>`, ablock: '' }),
    exp: [
      { id: `m${slot}_1`, stableId: `question-${USAGE}-${slot}#1`, sourceType: 'moodle:multianswer', kind: 'text', prompt: 'The capital of Italy is [[1]] and it has [[2]] famous river.', required: false },
      { id: `m${slot}_2`, stableId: `question-${USAGE}-${slot}#2`, sourceType: 'moodle:multianswer', kind: 'select', prompt: 'The capital of Italy is [[1]] and it has [[2]] famous river.', options: [{ text: 'one' }, { text: 'two' }], required: false }
    ] as ExpectedQuestion[],
    gold: { [`m${slot}_1`]: { text: 'Rome' }, [`m${slot}_2`]: { optionTexts: ['one'] } } as Record<string, GoldAnswer>
  }),
  gapselect: (slot = 10) => ({
    html: que({ slot, type: 'gapselect', qtext: `<p>Water boils at <span class="control group1"><select id="q${USAGE}:${slot}_p1" name="q${USAGE}:${slot}_p1" class="select custom-select"><option value="">&nbsp;</option><option value="1">100</option><option value="2">50</option></select></span> degrees Celsius at sea level.</p>`, ablock: '' }),
    exp: [{ id: `m${slot}_1`, stableId: `question-${USAGE}-${slot}#1`, sourceType: 'moodle:gapselect', kind: 'select', prompt: 'Water boils at [[1]] degrees Celsius at sea level.', options: [{ text: '100' }, { text: '50' }], required: false }] as ExpectedQuestion[],
    gold: { [`m${slot}_1`]: { optionTexts: ['100'] } } as Record<string, GoldAnswer>
  }),
  /** Essay with an online-text box AND a Moodle file manager (needs the file-picker dialog). */
  essayAttachment: (slot = 11) => ({
    html: que({
      slot, type: 'essay', qtext: '<p>Write a short report and upload your file.</p>',
      ablock: `<div class="answer"><textarea id="q${USAGE}:${slot}_answer" name="q${USAGE}:${slot}_answer" class="form-control" rows="10"></textarea></div>`,
      attachments: `<div class="attachments"><div class="filemanager fm-loading" id="filemanager-${slot}"><div class="fp-navbar"><div class="fp-toolbar"><a class="fp-btn-add" role="button" href="#">Add...</a></div></div><div class="fp-content"></div><input type="hidden" name="q${USAGE}:${slot}_attachments" value="123456"></div></div>`
    }),
    exp: [
      { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:essay', kind: 'textarea', prompt: 'Write a short report and upload your file.', required: false },
      { id: `m${slot}_att`, stableId: `question-${USAGE}-${slot}#attachment`, sourceType: 'moodle:essay', kind: 'unsupported', prompt: 'Write a short report and upload your file.', required: false, unsupported: true }
    ] as ExpectedQuestion[]
  }),
  mathRaw: (slot = 12) => ({
    html: que({ slot, type: 'multichoice', qtext: `<p>Solve for x: <span class="filter_mathjaxloader_equation"><span class="nolink">\\(x^2 - 5x + 6 = 0\\)</span></span></p>`, ablock: choices(slot, false, [{ text: '', html: '<p><span class="filter_mathjaxloader_equation"><span class="nolink">\\(x=2,\\ x=3\\)</span></span></p>' }, { text: '', html: '<p><span class="filter_mathjaxloader_equation"><span class="nolink">\\(x=1,\\ x=6\\)</span></span></p>' }]) }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:multichoice', kind: 'radio', prompt: 'Solve for x: \\(x^2 - 5x + 6 = 0\\)', options: [{ text: '\\(x=2,\\ x=3\\)', media: ['math'] }, { text: '\\(x=1,\\ x=6\\)', media: ['math'] }], required: false, media: ['math'] } as ExpectedQuestion,
    gold: { optionTexts: ['\\(x=2,\\ x=3\\)'] } as GoldAnswer
  }),
  mathRendered: (slot = 13) => ({
    html: que({ slot, type: 'shortanswer', qtext: `<p>Evaluate <mjx-container class="MathJax" jax="CHTML"><mjx-math aria-hidden="true"><mjx-mfrac><mjx-num>1</mjx-num><mjx-den>2</mjx-den></mjx-mfrac></mjx-math><mjx-assistive-mml unselectable="on" display="inline"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mfrac><mn>1</mn><mn>2</mn></mfrac></mrow><annotation encoding="application/x-tex">\\frac{1}{2}</annotation></semantics></math></mjx-assistive-mml></mjx-container> + 1 as a decimal.</p>`, ablock: textInput(slot) }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:shortanswer', kind: 'text', prompt: 'Evaluate \\(\\frac{1}{2}\\) + 1 as a decimal.', required: false, media: ['math'] } as ExpectedQuestion,
    gold: { text: '1.5' } as GoldAnswer
  }),
  imageInQuestion: (slot = 14) => ({
    html: que({ slot, type: 'multichoice', qtext: `<p>Identify the shape.</p><p><img src="/pluginfile.php/21/question/questiontext/${USAGE}/${slot}/1/triangle.png" alt="A three-sided polygon" width="120" height="100"></p>`, ablock: choices(slot, false, [{ text: 'Triangle' }, { text: 'Square' }, { text: 'Circle' }]) }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:multichoice', kind: 'radio', prompt: 'Identify the shape.', options: [{ text: 'Triangle' }, { text: 'Square' }, { text: 'Circle' }], required: false, media: ['img'] } as ExpectedQuestion,
    gold: { optionTexts: ['Triangle'] } as GoldAnswer
  }),
  plainNoImage: (slot = 15) => ({
    html: que({ slot, type: 'truefalse', qtext: '<p>Water is wet.</p>', ablock: `<div class="answer"><div class="r0"><input type="radio" name="q${USAGE}:${slot}_answer" value="1" id="q${USAGE}:${slot}_answer1"><label for="q${USAGE}:${slot}_answer1">True</label></div><div class="r1"><input type="radio" name="q${USAGE}:${slot}_answer" value="0" id="q${USAGE}:${slot}_answer0"><label for="q${USAGE}:${slot}_answer0">False</label></div></div>` }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:truefalse', kind: 'radio', prompt: 'Water is wet.', options: [{ text: 'True' }, { text: 'False' }], required: false, media: [] } as ExpectedQuestion,
    gold: { optionTexts: ['True'] } as GoldAnswer
  }),
  imageInOption: (slot = 16) => ({
    html: que({ slot, type: 'multichoice', qtext: '<p>Which flag is the flag of Japan?</p>', ablock: choices(slot, false, [{ text: 'Flag A', html: `<p>Flag A <img src="/pluginfile.php/21/question/answer/${USAGE}/${slot}/1/a.png" alt="red circle on white"></p>` }, { text: 'Flag B', html: `<p>Flag B <img src="/pluginfile.php/21/question/answer/${USAGE}/${slot}/2/b.png" alt="blue cross"></p>` }]) }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:multichoice', kind: 'radio', prompt: 'Which flag is the flag of Japan?', options: [{ text: 'Flag A', media: ['img'] }, { text: 'Flag B', media: ['img'] }], required: false, media: [] } as ExpectedQuestion,
    gold: { optionTexts: ['Flag A'] } as GoldAnswer
  }),
  ddwtos: (slot = 17) => ({
    html: que({ slot, type: 'ddwtos', qtext: `<p>The <span class="placeholder p1">sky</span> is <input type="hidden" name="q${USAGE}:${slot}_p1" class="placeholder p1" value="0"> in daytime.</p>`, ablock: `<div class="answercontainer"><span class="draghome choice1 group1" tabindex="0">blue</span><span class="draghome choice2 group1" tabindex="0">green</span></div>` }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:ddwtos', kind: 'unsupported', prompt: 'The sky is in daytime.', required: false, unsupported: true } as ExpectedQuestion
  }),
  ddmarker: (slot = 18) => ({
    html: que({ slot, type: 'ddmarker', qtext: '<p>Drag the marker onto the capital on the map.</p>', ablock: `<div class="ddarea"><img class="dropbackground" src="/pluginfile.php/21/qtype_ddmarker/bgimage/${USAGE}/${slot}/map.png" alt="map"><div class="dragitems"><span class="marker dragitem choice1">Hanoi</span></div><input type="hidden" name="q${USAGE}:${slot}_c1" class="choices choice1" value=""></div>` }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:ddmarker', kind: 'unsupported', prompt: 'Drag the marker onto the capital on the map.', required: false, unsupported: true } as ExpectedQuestion
  }),
  ordering: (slot = 19) => ({
    html: que({ slot, type: 'ordering', qtext: '<p>Put these steps in order.</p>', ablock: `<ul class="sortablelist"><li class="sortableitem" tabindex="0">Boil</li><li class="sortableitem" tabindex="0">Pour</li></ul><input type="hidden" name="q${USAGE}:${slot}_response_1" value="1,2">` }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:ordering', kind: 'unsupported', prompt: 'Put these steps in order.', required: false, unsupported: true } as ExpectedQuestion
  }),
  /** Third-party question type whose markup merely CONTAINS a textarea: must not be downgraded to plain text. */
  unknownPlugin: (slot = 20) => ({
    html: que({ slot, type: 'coderunner', qtext: '<p>Write a function that returns the square of n.</p>', ablock: `<div class="answer"><textarea id="q${USAGE}:${slot}_answer" name="q${USAGE}:${slot}_answer" class="coderunner-answer edit_code" rows="18"></textarea></div>` }),
    exp: { id: `m${slot}`, stableId: `question-${USAGE}-${slot}`, sourceType: 'moodle:coderunner', kind: 'unsupported', prompt: 'Write a function that returns the square of n.', required: false, unsupported: true } as ExpectedQuestion
  }),
  /** Informational "description" item: not a question, must be neither counted nor treated as one. */
  description: (slot = 21) => ({
    html: `<div id="question-${USAGE}-${slot}" class="que description informationitem"><div class="info"><h3 class="no">Information</h3></div><div class="content"><div class="formulation clearfix"><div class="qtext"><p>Read the following passage carefully before answering.</p></div></div></div></div>`,
    exp: [] as ExpectedQuestion[]
  })
};

/** Deterministic permutation so "randomised option order" is reproducible. */
export function permute<T>(arr: T[], seed?: number): T[] {
  if (seed === undefined) return [...arr];
  const a = [...arr]; let s = seed >>> 0 || 1;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function quizPage(slotsHtml: string[], opts: { page?: number; next?: boolean; prev?: boolean } = {}): string {
  const c = chrome(opts);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="generator" content="Moodle"><title>Quiz: attempt</title>
  <style>.sr-only,.accesshide{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style></head>
  <body id="page-mod-quiz-attempt" class="path-mod path-mod-quiz format-topics moodle">${c.head}${slotsHtml.join('\n')}${c.foot}</body></html>`;
}

const flat = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);
function fx(name: string, category: string, parts: { html: string; exp: ExpectedQuestion | ExpectedQuestion[]; gold?: GoldAnswer | Record<string, GoldAnswer> }[], page = 0): MoodleFixture {
  const expected = parts.flatMap(p => flat(p.exp));
  const gold: Record<string, GoldAnswer> = {};
  for (const p of parts) {
    if (!p.gold) continue;
    const single = flat(p.exp)[0];
    if ('optionTexts' in p.gold || 'text' in p.gold) { if (single) gold[single.id] = p.gold as GoldAnswer; }
    else Object.assign(gold, p.gold as Record<string, GoldAnswer>);
  }
  return { name, category, url: attemptUrl(page), html: quizPage(parts.map(p => p.html), { page }), expected, gold };
}

export function allFixtures(): MoodleFixture[] {
  return [
    fx('single-choice (4.x markup)', 'single', [SLOT.single()]),
    fx('single-choice (3.x label-for markup)', 'single', [SLOT.single({ legacy: true })]),
    fx('multiple-choice', 'multi', [SLOT.multi()]),
    fx('true/false', 'truefalse', [SLOT.truefalse()]),
    fx('short answer', 'shortanswer', [SLOT.shortanswer()]),
    fx('numerical', 'numerical', [SLOT.numerical()]),
    fx('essay (textarea, required)', 'essay', [SLOT.essay()]),
    fx('essay (Atto contenteditable)', 'essay', [SLOT.essayAtto()]),
    fx('matching', 'match', [SLOT.match()]),
    fx('cloze / embedded answers', 'cloze', [SLOT.cloze()]),
    fx('dropdown (gapselect)', 'dropdown', [SLOT.gapselect()]),
    fx('file upload (Moodle filemanager)', 'file-upload', [SLOT.essayAttachment()]),
    fx('math (raw TeX delimiters)', 'math', [SLOT.mathRaw()]),
    fx('math (rendered MathJax container)', 'math', [SLOT.mathRendered()]),
    fx('image in question text', 'image', [SLOT.imageInQuestion(), SLOT.plainNoImage()]),
    fx('image in option only', 'image', [SLOT.imageInOption()]),
    fx('unsupported: drag-and-drop into text', 'unsupported', [SLOT.ddwtos()]),
    fx('unsupported: drag markers on image', 'unsupported', [SLOT.ddmarker()]),
    fx('unsupported: ordering', 'unsupported', [SLOT.ordering()]),
    fx('unsupported: unknown plugin type containing a textarea', 'unsupported', [SLOT.unknownPlugin()]),
    fx('description item is not a question', 'description', [SLOT.description(), SLOT.single({ slot: 22 })]),
    fx('multi-page quiz: page 1 (slots 1-2)', 'multipage', [SLOT.single({ slot: 1 }), SLOT.multi({ slot: 2 })], 0),
    fx('multi-page quiz: page 2 (slots 3-4)', 'multipage', [SLOT.truefalse(3), SLOT.shortanswer(4)], 1),
    fx('randomised option order (seed 1)', 'randomised', [SLOT.single({ shuffle: 1 }), SLOT.multi({ shuffle: 1 })]),
    fx('randomised option order (seed 7)', 'randomised', [SLOT.single({ shuffle: 7 }), SLOT.multi({ shuffle: 7 })])
  ];
}

/** Non-question UI that must never be extracted from a quiz page. */
export const CHROME_NAMES = ['q', 'courseSearch', 'jump', 'timerfield', 'previous', 'next'];
