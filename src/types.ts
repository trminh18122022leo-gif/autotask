import type { Page } from 'playwright';
import type { ProviderSpec } from './providers.js';

/** 'unsupported' marks a question the scanner recognised but cannot fill safely; it must be reviewed by a person and is never treated as plain text. */
export type QuestionKind = 'radio' | 'checkbox' | 'text' | 'textarea' | 'select' | 'file' | 'ordering' | 'dragdrop' | 'moodle-file' | 'code' | 'unsupported';
/** A media element found inside the scope of exactly one question (or one option). */
export interface MediaRef { type: 'img' | 'video' | 'audio' | 'canvas' | 'svg' | 'iframe' | 'math'; src?: string; alt?: string; scope: 'question' | 'option'; optionId?: string }
export interface Option { id: string; text: string; /** DOM value attribute when one exists (Moodle: index in the shuffled order, NOT a stable identity). */ value?: string; media?: MediaRef[] }
export interface Question {
  id: string; kind: QuestionKind; prompt: string; options: Option[]; required: boolean; hasVisual: boolean;
  /** Identity that survives re-ordering/re-scans (Moodle: question-<usage>-<slot>[#sub]). Absent on generic pages. */
  stableId?: string;
  /** e.g. 'moodle:multichoice'. Only set when the platform DOM states the type. */
  sourceType?: string;
  /** Page/step identity, e.g. 'attempt=7&page=1' for Moodle attempts, pathname+query otherwise. */
  pageKey?: string;
  media?: MediaRef[];
  /** Visible/labelled drop zones for a verified drag/drop adapter. */
  zones?: Option[];
  unsupportedReason?: string;
  /** Set when answering needs the learner to listen/speak/record; the agent must not answer on their behalf. */
  humanOnly?: string;
}
export type LmsOperationMode = 'READ_ONLY' | 'PRACTICE_ASSISTED' | 'ASSESSMENT_RESTRICTED';
/** AI is the default answer source. FORM_FILE is opt-in for form-entry tasks, never automatic quiz-answer priority. */
export type AnswerSourceMode = 'AI_PRIMARY' | 'FORM_FILE';

export interface AttemptStartConfirmationContext {
  taskId: string;
  url: string;
  title: string;
  buttonLabel: string;
  platform: string;
}

export interface VerifiedAttemptIdentity {
  canonicalOrigin: string;
  pathname?: string;
  cmid?: string;
  quizId?: string;
  attemptId?: string;
  taskId?: string;
  scopeProof?: string;
  verifiedAt?: string;
}

export interface Answer { id: string; selected?: string[]; placements?: {itemId:string;zoneId:string}[]; text?: string; fileName?: string; fileContent?: string; localFilePath?: string; confidence?: number }
export interface Task {
  id: string; url: string; title?: string; aiPermitted: boolean; submitButton?: string; nextButton?: string; maxPages?: number; successText?: string; scoreSelector?: string; note?:string; answerFilePaths?:string[]; answerSourceMode?:AnswerSourceMode;
  /** Site-specific visible challenge fields; user supplies the value, never the AI. */
  challengeInputSelector?: string; challengeVerifySelector?: string; allowResubmit?: boolean;
  /** Explicit operating mode: READ_ONLY, PRACTICE_ASSISTED, or ASSESSMENT_RESTRICTED. */
  mode?: LmsOperationMode;
  /** Separate explicit confirmation required before clicking "Attempt quiz now" / creating a NEW self-practice attempt. */
  confirmStartNewAttempt?: boolean;
  startGrantConsumed?: boolean;
  consumedGrantKey?: string;
  consumedGrantAt?: string;
  verifiedAttemptIdentity?: VerifiedAttemptIdentity;
  /** Operator declaration (never inferred) that this task URL is a permitted ungraded self-practice activity.
   *  Only relevant for DIRECT quiz-attempt URLs; it NEVER overrides READ_ONLY, ASSESSMENT_RESTRICTED, or graded-quiz signals found in the live DOM. */
  scopeAttestation?: 'PERMITTED_SELF_PRACTICE';
  /** Opt-in adapters only for verified, ungraded self-practice. Unknown DOM structures remain unsupported. */
  advancedLmsAdapters?: {ordering?:boolean;dragdrop?:boolean;codeDraft?:boolean;fileManager?:boolean};
  /** Local files explicitly selected by the user, keyed by question.id or stableId. Never supplied by AI. */
  attachmentFiles?: Record<string,string>;
}
export interface AppConfig {
  allowedHosts: string[];
  /** Optional local form-entry data files; unused unless FORM_FILE is explicitly selected. */
  answerFilePaths?: string[];
  /** AI_PRIMARY (default) solves all supported questions; FORM_FILE is opt-in for forms, not Moodle quizzes. */
  answerSourceMode?: AnswerSourceMode;
  /** CLI challenge pauses; manual user solves CAPTCHA/OTP in browser, never automated bypass. */
  interactiveAuthRecovery?: boolean;
  /** Optional strict origin allowlist (e.g. ["https://lms.hust.edu.vn"]). */
  allowedOrigins?: string[];
  /** Whether local loopback http://127.0.0.1:<port> or http://localhost:<port> is allowed when explicitly listed in allowedHosts. Defaults to true when loopback host is in allowedHosts. */
  allowLocalHttpSandbox?: boolean;
  approvedForAIUse: boolean;
  parallelTabs: number;
  authUrls: string[];
  deadlinePages: string[];
  tasks: Task[];
  provider: ProviderSpec;
  deadlineOffset?: string;
  accountId?:string;
  autoDiscover?:boolean;
  discoveryStartUrls?:string[];
  maxDiscoveryPages?:number;
  fallbackProfileIds?:string[];
  maxAttemptsPerModel?:number;
  accessWatchMinutes?:number;
  forceResubmit?: boolean;
  /** Extra hosts the user has verified are Moodle. Must ALSO be in allowedHosts; never auto-populated. */
  moodleHosts?: string[];
  /** Global default operating mode for LMS activities. */
  operationMode?: LmsOperationMode;
  /** Interactive/callback gate for confirming creation of a new self-practice quiz attempt at runtime. */
  confirmAttemptStart?: (ctx: AttemptStartConfirmationContext) => Promise<boolean>;
}
export interface Deadline { label: string; dueAt: string; source: string; remainingHours: number | null }
export type Status = 'READY_FOR_REVIEW'|'PARTIAL'|'ERROR'|'SUBMITTED'|'UNCONFIRMED'|'NOT_SUBMITTED'|'WAITING_FOR_ACCESS'|'NEEDS_REVIEW'|'WAITING_FOR_AUTH';
export interface TaskResult {
 id: string; url: string; title: string; status: Status; startedAt: string; finishedAt?: string;
 questionsFound: number; questionsFilled: number; warnings: string[]; deadline?: string;
 scoreObserved?: string | null; accessGate?:{kind:string;reason:string;remainingSeconds?:number;recheckAfter?:string}; page?: Page;
 /** Mutating HTTP requests / action URLs that the READ_ONLY network guard blocked while the page was open. */
 readOnlyBlockedRequests?: string[];
 /** Phase 9B: what has actually been verified for filled fields. READY_FOR_REVIEW never implies server persistence.
  *  domFilled = fields the agent filled; domVerified = fields whose DOM still equals the intended answer after a settle delay;
  *  serverWriteAcks = client-observed write responses after filling: WRITE_ACK_RECEIVED means a 2xx response arrived, which is NOT proof the backend stored the data;
  *  serverReadbackVerified = independent server/reload readback, only performed by dedicated adapters (generic run: NOT_PERFORMED). */
 persistence?: { domFilled: number; domVerified: number; serverWriteAcks: 'NONE_OBSERVED' | 'WRITE_ACK_RECEIVED' | 'WRITE_FAILED'; serverWriteFailures: number; serverReadbackVerified: 'NOT_PERFORMED' };
}
