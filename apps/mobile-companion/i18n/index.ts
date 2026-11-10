// i18n (A024): a tiny typed dictionary, no external library. Vietnamese is the default; the
// English table must cover exactly the same keys (type-checked through `Messages`).

import type { ClientErrorCode, ContractErrorCode, QrRejectReason } from '../src/core';

export type Locale = 'vi' | 'en';

export const LOCALES: readonly Locale[] = ['vi', 'en'];
export const DEFAULT_LOCALE: Locale = 'vi';

export type MessageKey =
  // unlock gate
  | 'unlock.title'
  | 'unlock.subtitle'
  | 'unlock.prompt'
  | 'unlock.button'
  | 'unlock.cancelled'
  | 'unlock.failed'
  | 'unlock.lockedOut'
  | 'unlock.unavailable'
  | 'unlock.passcodeOnly'
  // tabs / sessions
  | 'tabs.running'
  | 'tabs.idle'
  | 'tabs.archived'
  | 'sessions.search'
  | 'sessions.empty'
  | 'sessions.emptySearch'
  | 'sessions.needsDecision'
  | 'sessions.updatedAgo'
  | 'sessions.hiddenOlder'
  | 'sessions.pair'
  | 'sessions.forget'
  | 'sessions.forgetConfirm'
  | 'sessions.settings'
  | 'sessions.refresh'
  // pairing
  | 'pair.title'
  | 'pair.scan'
  | 'pair.cameraPermission'
  | 'pair.cameraPermissionButton'
  | 'pair.manual'
  | 'pair.manualPlaceholder'
  | 'pair.submit'
  | 'pair.connecting'
  | 'pair.success'
  | 'pair.errorTitle'
  | 'pair.error.remoteDisabled'
  | 'pair.error.expired'
  | 'pair.error.pinMismatch'
  | 'pair.error.unavailable'
  | 'pair.error.appUpdate'
  | 'pair.error.hostUpdate'
  | 'pair.error.generic'
  // session screen
  | 'session.loading'
  | 'session.empty'
  | 'session.composerPlaceholder'
  | 'session.send'
  | 'session.cancel'
  | 'session.cancelConfirmTitle'
  | 'session.cancelConfirmBody'
  | 'session.cancelConfirm'
  | 'session.cancelled'
  | 'session.historyOlder'
  | 'session.pending'
  | 'session.failed'
  | 'session.retry'
  // approvals
  | 'approval.title'
  | 'approval.approve'
  | 'approval.reject'
  | 'approval.decideOnComputer'
  | 'approval.changed'
  | 'approval.reviewAgain'
  | 'approval.alreadyDecided'
  | 'approval.retry'
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.cancelledElsewhere'
  | 'approval.unavailableElsewhere'
  // banners / notifications
  | 'banner.reconnecting'
  | 'banner.offline'
  | 'banner.gatewayOff'
  | 'banner.revoked'
  | 'banner.reauth'
  | 'banner.pinnedTransportMissing'
  // protocol update (N7)
  | 'update.appTitle'
  | 'update.appBody'
  | 'update.hostTitle'
  | 'update.hostBody'
  | 'update.details'
  | 'update.retry'
  | 'update.pairAnother'
  | 'notice.notification.title'
  | 'notice.notification.body'
  // common
  | 'common.ok'
  | 'common.cancel'
  | 'common.back'
  | 'common.host';

type MessageFunction = (params: Record<string, string | number>) => string;
export type Messages = Record<MessageKey, string | MessageFunction>;

const PLACEHOLDER_RE = /\{(\w+)\}/g;

function format(template: string, params: Record<string, string | number> | undefined): string {
  if (params === undefined) return template;
  return template.replace(PLACEHOLDER_RE, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

export type Interpolate = (key: MessageKey, params?: Record<string, string | number>) => string;

// ---------------------------------------------------------------------------
// English
// ---------------------------------------------------------------------------

const en = {
  'unlock.title': 'DSH Companion',
  'unlock.subtitle': 'Unlock to reach your paired computer.',
  'unlock.prompt': 'Unlock DSH Companion',
  'unlock.button': 'Unlock',
  'unlock.cancelled': 'Unlock cancelled. Your credential stays locked.',
  'unlock.failed': 'Could not verify you. Try again.',
  'unlock.lockedOut': 'Too many attempts. Unlock your phone, then retry.',
  'unlock.unavailable': 'Set up a screen lock (passcode, PIN or biometrics) to protect the paired credential.',
  'unlock.passcodeOnly': 'Biometrics are not set up; using your device passcode.',
  'tabs.running': 'Running',
  'tabs.idle': 'Idle',
  'tabs.archived': 'Archived',
  'sessions.search': 'Search sessions',
  'sessions.empty': 'No sessions in this tab yet.',
  'sessions.emptySearch': 'No session matches your search.',
  'sessions.needsDecision': 'Needs your decision',
  'sessions.updatedAgo': 'updated {when}',
  'sessions.hiddenOlder': '{count} older sessions are outside the 30-day window.',
  'sessions.pair': 'Pair a computer',
  'sessions.forget': 'Forget this computer',
  'sessions.forgetConfirm': 'Remove the stored credential and pair again later?',
  'sessions.settings': 'Settings',
  'sessions.refresh': 'Refresh',
  'pair.title': 'Pair your computer',
  'pair.scan': 'Point the camera at the QR code on your computer',
  'pair.cameraPermission': 'Camera access is needed to scan the pairing QR code.',
  'pair.cameraPermissionButton': 'Allow camera',
  'pair.manual': 'Or paste the code shown on your computer',
  'pair.manualPlaceholder': 'Paste the pairing code',
  'pair.submit': 'Pair',
  'pair.connecting': 'Connecting to {host}…',
  'pair.success': 'Paired with {host}',
  'pair.errorTitle': 'Could not pair',
  'pair.error.remoteDisabled': 'Remote control is off on your computer. Turn it on in DSH, then scan a new code.',
  'pair.error.expired': 'This pairing code expired or was already used. Show a new one on your computer.',
  'pair.error.pinMismatch': 'That computer is not the one the code belongs to. Nothing was sent. If its certificate changed, pair again with a fresh code.',
  'pair.error.unavailable': 'Could not reach that computer. Check you are on the same network and the gateway is running.',
  'pair.error.appUpdate': 'Your computer needs a newer DSH Companion. Update the app.',
  'pair.error.hostUpdate': 'Your computer runs an older protocol. Update DSH on the desktop.',
  'pair.error.generic': 'Pairing failed. Show a new code and try again.',
  'session.loading': 'Loading conversation…',
  'session.empty': 'No messages yet.',
  'session.composerPlaceholder': 'Send an instruction…',
  'session.send': 'Send',
  'session.cancel': 'Stop session',
  'session.cancelConfirmTitle': 'Stop this session?',
  'session.cancelConfirmBody': 'The agent stops working on the computer.',
  'session.cancelConfirm': 'Stop',
  'session.cancelled': 'Session stopped.',
  'session.historyOlder': 'Load earlier messages',
  'session.pending': 'sending…',
  'session.failed': 'not sent',
  'session.retry': 'Retry',
  'approval.title': 'Approval needed: {tool}',
  'approval.approve': 'Allow once',
  'approval.reject': 'Reject',
  'approval.decideOnComputer': 'Decide on your computer',
  'approval.changed': 'This request changed since you opened it. Review again.',
  'approval.reviewAgain': 'Review again',
  'approval.alreadyDecided': 'Already decided.',
  'approval.retry': 'Try again',
  'approval.approved': 'Allowed once',
  'approval.rejected': 'Rejected',
  'approval.cancelledElsewhere': 'Cancelled on another device.',
  'approval.unavailableElsewhere': 'No longer available.',
  'banner.reconnecting': 'Reconnecting…',
  'banner.offline': 'Offline — showing the last known state.',
  'banner.gatewayOff': 'Remote control is off on your computer. Auto-reconnect is paused.',
  'banner.revoked': 'This device was removed from the computer. Pair again to continue.',
  'banner.reauth': 'The computer asks to re-authenticate. Reconnecting…',
  'banner.pinnedTransportMissing':
    'This build has no pinned TLS transport (Expo Go / web). Install a dev build to connect; the app will not fall back to an unpinned socket.',
  'update.appTitle': 'Update DSH Companion',
  'update.appBody': 'Your computer needs a newer version of this app. Install the new build, then tap Retry.',
  'update.hostTitle': 'Update DSH on your computer',
  'update.hostBody': 'Your computer speaks an older protocol than this app. Update DSH on the desktop, then tap Retry.',
  'update.details': 'Protocol version {version}',
  'update.retry': 'Retry',
  'update.pairAnother': 'Pair a different computer',
  'notice.notification.title': 'DSH needs your decision',
  'notice.notification.body': (params) => `A ${String(params.tool ?? 'tool')} call is waiting.`,
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.back': 'Back',
  'common.host': 'Computer',
} satisfies Messages;

// ---------------------------------------------------------------------------
// Vietnamese
// ---------------------------------------------------------------------------

const vi = {
  'unlock.title': 'DSH Companion',
  'unlock.subtitle': 'Mở khoá để kết nối máy tính đã ghép đôi.',
  'unlock.prompt': 'Mở khoá DSH Companion',
  'unlock.button': 'Mở khoá',
  'unlock.cancelled': 'Đã huỷ mở khoá. Thông tin đăng nhập vẫn được giữ kín.',
  'unlock.failed': 'Không xác minh được. Vui lòng thử lại.',
  'unlock.lockedOut': 'Đã thử quá nhiều lần. Mở khoá điện thoại rồi thử lại.',
  'unlock.unavailable': 'Hãy đặt khoá màn hình (mã PIN hoặc sinh trắc học) để bảo vệ thông tin đã ghép đôi.',
  'unlock.passcodeOnly': 'Chưa đặt sinh trắc học; đang dùng mã mở khoá thiết bị.',
  'tabs.running': 'Đang chạy',
  'tabs.idle': 'Chờ',
  'tabs.archived': 'Lưu trữ',
  'sessions.search': 'Tìm phiên',
  'sessions.empty': 'Chưa có phiên nào trong mục này.',
  'sessions.emptySearch': 'Không có phiên nào khớp tìm kiếm.',
  'sessions.needsDecision': 'Cần bạn quyết định',
  'sessions.updatedAgo': 'cập nhật {when}',
  'sessions.hiddenOlder': '{count} phiên cũ hơn nằm ngoài cửa sổ 30 ngày.',
  'sessions.pair': 'Ghép đôi máy tính',
  'sessions.forget': 'Quên máy tính này',
  'sessions.forgetConfirm': 'Xoá thông tin đăng nhập đã lưu và ghép đôi lại sau?',
  'sessions.settings': 'Cài đặt',
  'sessions.refresh': 'Làm mới',
  'pair.title': 'Ghép đôi máy tính',
  'pair.scan': 'Hướng camera vào mã QR trên máy tính',
  'pair.cameraPermission': 'Cần quyền camera để quét mã QR ghép đôi.',
  'pair.cameraPermissionButton': 'Cho phép camera',
  'pair.manual': 'Hoặc dán mã hiển thị trên máy tính',
  'pair.manualPlaceholder': 'Dán mã ghép đôi',
  'pair.submit': 'Ghép đôi',
  'pair.connecting': 'Đang kết nối tới {host}…',
  'pair.success': 'Đã ghép đôi với {host}',
  'pair.errorTitle': 'Không ghép đôi được',
  'pair.error.remoteDisabled': 'Điều khiển từ xa đang tắt trên máy tính. Hãy bật trong DSH và quét mã mới.',
  'pair.error.expired': 'Mã ghép đôi đã hết hạn hoặc đã dùng. Hãy hiển thị mã mới trên máy tính.',
  'pair.error.pinMismatch': 'Máy tính này không khớp với mã. Không có dữ liệu nào được gửi. Nếu chứng chỉ vừa đổi, hãy ghép đôi lại bằng mã mới.',
  'pair.error.unavailable': 'Không kết nối được máy tính. Kiểm tra cùng mạng và gateway đang chạy.',
  'pair.error.appUpdate': 'Máy tính cần bản DSH Companion mới hơn. Hãy cập nhật ứng dụng.',
  'pair.error.hostUpdate': 'Máy tính dùng giao thức cũ hơn. Hãy cập nhật DSH trên máy tính.',
  'pair.error.generic': 'Ghép đôi thất bại. Hãy hiển thị mã mới và thử lại.',
  'session.loading': 'Đang tải hội thoại…',
  'session.empty': 'Chưa có tin nhắn.',
  'session.composerPlaceholder': 'Gửi chỉ dẫn…',
  'session.send': 'Gửi',
  'session.cancel': 'Dừng phiên',
  'session.cancelConfirmTitle': 'Dừng phiên này?',
  'session.cancelConfirmBody': 'Agent sẽ dừng làm việc trên máy tính.',
  'session.cancelConfirm': 'Dừng',
  'session.cancelled': 'Đã dừng phiên.',
  'session.historyOlder': 'Tải tin nhắn cũ hơn',
  'session.pending': 'đang gửi…',
  'session.failed': 'chưa gửi',
  'session.retry': 'Gửi lại',
  'approval.title': 'Cần phê duyệt: {tool}',
  'approval.approve': 'Cho phép một lần',
  'approval.reject': 'Từ chối',
  'approval.decideOnComputer': 'Quyết định trên máy tính',
  'approval.changed': 'Yêu cầu đã thay đổi kể từ khi bạn mở. Hãy xem lại.',
  'approval.reviewAgain': 'Xem lại',
  'approval.alreadyDecided': 'Đã được quyết định.',
  'approval.retry': 'Thử lại',
  'approval.approved': 'Đã cho phép một lần',
  'approval.rejected': 'Đã từ chối',
  'approval.cancelledElsewhere': 'Đã huỷ trên thiết bị khác.',
  'approval.unavailableElsewhere': 'Không còn hiệu lực.',
  'banner.reconnecting': 'Đang kết nối lại…',
  'banner.offline': 'Ngoại tuyến — đang hiển thị trạng thái gần nhất.',
  'banner.gatewayOff': 'Điều khiển từ xa đang tắt trên máy tính. Tự kết nối lại đã tạm dừng.',
  'banner.revoked': 'Thiết bị này đã bị xoá khỏi máy tính. Hãy ghép đôi lại để tiếp tục.',
  'banner.reauth': 'Máy tính yêu cầu xác thực lại. Đang kết nối lại…',
  'banner.pinnedTransportMissing':
    'Bản này không có kênh TLS ghim chứng chỉ (Expo Go / web). Hãy cài bản dev build để kết nối; ứng dụng không bao giờ chuyển sang kết nối không ghim.',
  'update.appTitle': 'Cập nhật DSH Companion',
  'update.appBody': 'Máy tính cần bản ứng dụng mới hơn. Hãy cài bản mới rồi nhấn Thử lại.',
  'update.hostTitle': 'Cập nhật DSH trên máy tính',
  'update.hostBody': 'Máy tính dùng giao thức cũ hơn ứng dụng này. Hãy cập nhật DSH trên máy tính rồi nhấn Thử lại.',
  'update.details': 'Phiên bản giao thức {version}',
  'update.retry': 'Thử lại',
  'update.pairAnother': 'Ghép đôi máy tính khác',
  'notice.notification.title': 'DSH cần bạn quyết định',
  'notice.notification.body': (params) => `Lời gọi ${String(params.tool ?? 'công cụ')} đang chờ.`,
  'common.ok': 'OK',
  'common.cancel': 'Huỷ',
  'common.back': 'Quay lại',
  'common.host': 'Máy tính',
} satisfies Messages;

const TABLES: Record<Locale, Messages> = { en, vi };

/** Every table, for completeness tests (both locales must cover the same keys). */
export const MESSAGES: Readonly<Record<Locale, Messages>> = TABLES;

/** The set of keys (`t()` accepts exactly these). */
export const MESSAGE_KEYS: readonly MessageKey[] = Object.keys(en) as MessageKey[];

/** Interpolator for one locale (`{name}` placeholders). */
export function t(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  const table = TABLES[locale] ?? TABLES[DEFAULT_LOCALE];
  const value = table[key] ?? TABLES[DEFAULT_LOCALE][key];
  if (typeof value === 'function') return value(params ?? {});
  return format(value, params);
}

/** The device locale, falling back to Vietnamese (spec: vi + en). */
export function detectLocale(languageTag: string | null | undefined): Locale {
  const tag = (languageTag ?? '').toLowerCase();
  if (tag.startsWith('vi')) return 'vi';
  if (tag.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
}

/**
 * Pairing failures are typed by the core (QrRejectReason, CoreError codes); this maps them to
 * user-facing copy covering every spec-002 US1 / edge-case state.
 */
export type PairErrorKind =
  | 'remoteDisabled'
  | 'expired'
  | 'pinMismatch'
  | 'unavailable'
  | 'appUpdate'
  | 'hostUpdate'
  | 'generic';

export function pairErrorFromQr(reason: QrRejectReason): PairErrorKind {
  switch (reason) {
    case 'qr/expired':
      return 'expired';
    case 'qr/invalid-json':
    case 'qr/unsupported-version':
    case 'qr/bad-endpoint':
    case 'qr/bad-gateway-id':
    case 'qr/bad-host-name':
    case 'qr/bad-cert-sha256':
    case 'qr/bad-pairing-code':
    case 'qr/bad-expires-at':
      return 'generic';
  }
}

export function pairErrorFromCode(code: ClientErrorCode | ContractErrorCode | string): PairErrorKind {
  switch (code) {
    case 'remote/disabled':
    case 'client/remote-disabled':
      return 'remoteDisabled';
    case 'pairing/expired':
    case 'auth/required':
      return 'expired';
    case 'client/pin-mismatch':
      return 'pinMismatch';
    case 'client/update-app-required':
      return 'appUpdate';
    case 'client/update-host-required':
      return 'hostUpdate';
    case 'client/pinned-transport-unavailable':
    case 'client/disconnected':
    case 'client/timeout':
    case 'auth/revoked':
      return 'unavailable';
    default:
      return 'generic';
  }
}

/** Relative "2 min ago" copy for the session rows (kept tiny on purpose). */
export function relativeTime(locale: Locale, ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return locale === 'vi' ? `${seconds}s` : `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return locale === 'vi' ? `${minutes} phút` : `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return locale === 'vi' ? `${hours} giờ` : `${hours} h`;
  const days = Math.round(hours / 24);
  return locale === 'vi' ? `${days} ngày` : `${days} d`;
}
