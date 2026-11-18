/** Types and Interfaces for AutoTask AI Autonomous Agent Mode */
import type { Browser, BrowserContext, Page } from 'playwright';
import type { AgentPlaybook } from './playbooks.js';
import type { AgentRunLogger } from './run-logger.js';

export type AgentToolName =
  | 'browser.open'
  | 'browser.navigate'
  | 'browser.observe'
  | 'browser.click'
  | 'browser.fill'
  | 'browser.type'
  | 'browser.scroll'
  | 'browser.readText'
  | 'browser.readLinks'
  | 'browser.findElement'
  | 'browser.waitFor'
  | 'browser.extractStructuredData'
  | 'browser.captureScreenshot'
  | 'browser.download'
  | 'agent.summarize'
  | 'agent.reportResult'
  | 'account.saveCredentials'
  | 'account.login'
  | 'quiz.solve'
  | 'browser.back';

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: string[];
  default?: any;
}

export interface ToolDefinition {
  name: AgentToolName;
  description: string;
  parameters: Record<string, ToolParameter>;
  isStateChanging?: boolean;
}

export interface ToolCall {
  tool: AgentToolName;
  args: Record<string, any>;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  observationText: string;
  urlAfter?: string;
}

export interface AgentStep {
  stepIndex: number;
  thought: string;
  plan?: string[];
  toolCall: ToolCall;
  result?: ToolResult;
  timestamp: string;
  durationMs?: number;
}

export type AgentGoalStatus =
  | 'RUNNING'
  | 'DONE'
  | 'NEEDS_REVIEW'
  | 'WAITING_FOR_AUTH'
  | 'FAILED'
  | 'STOPPED';

export interface AgentExecutionResult {
  goal: string;
  status: AgentGoalStatus;
  steps: AgentStep[];
  summary: string;
  data?: any;
  durationMs: number;
  modelCalls: number;
  finalUrl?: string;
  runLogPath?: string;
}

export interface ActivityFilterSpec {
  includeNumbers?: number[];
  excludeNumbers?: number[];
  fromNumber?: number;
  toNumber?: number;
  afterNumber?: number;
  afterQuery?: string;
  includeQueries?: string[];
  excludeQueries?: string[];
  maxGradeToReattempt?: number;
}

export interface AgentConfig {
  allowedHosts: string[];
  maxSteps?: number;
  maxModelCalls?: number;
  timeoutMs?: number;
  headless?: boolean;
  autoRead?: boolean;
  requireStateChangeApproval?: boolean;
  profileOverride?: string;
  modelOverride?: string;
  userStoragePath?: string;
  verbose?: boolean;
  accountId?: string;
  autoLogin?: boolean;
  targetWebUrl?: string;
  inMemoryCredentials?: { username: string; password: string };
  targetCourse?: string;
  targetActivity?: string;
  solveAll?: boolean;
  activityFilter?: ActivityFilterSpec;
  attachmentPath?: string;
  documentFormat?: 'docx' | 'pdf' | 'txt' | 'md' | 'csv' | 'xlsx' | 'png';
  solveAssignments?: boolean;
  useWordApp?: boolean;
  wordSavePath?: string;
  wordTemplatePath?: string;
  studentHeader?: string;
  handwritingMode?: boolean;
  handwritingSamplePath?: string;
  parallel?: boolean;
  concurrency?: number;
  targetCourses?: string[];
  allowReattempt?: boolean;
  userIntent?: string;
  playbookStorePath?: string;
  disablePlaybooks?: boolean;
  logDir?: string;
  disableLogs?: boolean;
}

export interface AgentContext {
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  activeUrl?: string;
  isLoggedIn?: boolean;
  activeAccountId?: string;
  collectedFindings: Record<string, any>;
  history: AgentStep[];
  currentTurnStartIndex?: number;
  goalHistory: { goal: string; summary: string; timestamp: string }[];
  matchedPlaybooks?: AgentPlaybook[];
  runLogger?: AgentRunLogger;
  config: AgentConfig;
}

export interface PageObservation {
  url: string;
  title: string;
  platform: 'moodle' | 'fami' | 'google-forms' | 'generic' | 'auth' | string;
  authRequired: boolean;
  headings: string[];
  interactiveElements: {
    text: string;
    tag: string;
    type?: string;
    selector?: string;
    href?: string;
  }[];
  courses?: { id?: string; name: string; url: string; code?: string }[];
  deadlines?: { title: string; course?: string; dueAt?: string; url?: string }[];
  activities?: { title: string; kind?: string; url: string; isCompleted?: boolean }[];
  quizStatus?: { isDone: boolean; canAttempt: boolean; grade?: string; state?: string; details: string };
  textSnippet: string;
}
