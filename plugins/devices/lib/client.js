// Browser half of @dsh-ext/devices (spec 008): a "Devices" page in DSH Settings.
// Plain JS, no build step: React.createElement via window.__ModuleLoader__, the
// same pattern as plugins/mobile-gateway/lib/client.js. The page reaches the
// local Host through same-origin fetch only (/mgw/* for this device's own
// gateway, /devices/* for outbound connections); it never holds a remote token.
window.__ModuleLoader__.load({
  id: '@dsh-ext/devices',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports

    // ---------------------------------------------------------------- i18n
    // vi/en; Vietnamese when the DSH locale is vi*, English otherwise (the
    // gateway reads the same ctx.locale snapshot: `getSnapshot().active`).
    const DICT = {
      en: {
        title: 'Devices',
        tabAllow: 'Allow connections to this device',
        tabConnect: 'Connect to other devices',
        allow: 'Allow connections',
        allowHelp: 'Let other devices on your network control this DSH Host after pairing. Off closes every connection.',
        lan: 'Local network (LAN)',
        internet: 'Internet',
        internetLater: 'Later — not available yet',
        generate: 'Generate pairing code',
        pairingCode: 'Pairing code',
        pairingHelp: 'Paste this on the other device. It works once and expires soon.',
        copy: 'Copy',
        copied: 'Copied',
        expiresIn: 'Expires in',
        expired: 'Expired — generate a new code',
        address: "This device's address",
        noAddress: 'No reachable address yet. Turn on "Allow connections".',
        authorized: 'Authorized devices',
        noAuthorized: 'No device is authorized yet.',
        kind: 'Type',
        scopes: 'Permissions',
        lastUsed: 'Last used',
        never: 'never',
        connectedHere: 'Connected here',
        remove: 'Remove access',
        removeConfirm: 'Remove access for this device? It is disconnected immediately.',
        edit: 'Edit permissions',
        editHelp: 'Permissions are fixed when a device pairs. Saving creates a new pairing code with the chosen permissions; the device must pair again, which closes its current connection.',
        editSave: 'Generate new pairing code',
        cancel: 'Cancel',
        'scope.sessions:read': 'See sessions and history',
        'scope.prompt:send': 'Send prompts',
        'scope.approval:respond': 'Answer approvals',
        'scope.files:read': 'Read files',
        'scope.files:write': 'Write files',
        'scope.settings:write': 'Change settings',
        addDevice: 'Add device',
        addressLabel: 'Address (ip:port)',
        pairingLabel: 'Pairing string',
        nameLabel: 'Name (optional)',
        connect: 'Pair and connect',
        remotes: 'Remote hosts',
        noRemotes: 'No remote host yet.',
        open: 'Open',
        back: 'Back',
        removeRemote: 'Remove',
        sessions: 'Sessions',
        noSessions: 'No sessions on this host.',
        history: 'History',
        noHistory: 'No messages.',
        prompt: 'Send a prompt',
        send: 'Send',
        approvals: 'Pending approvals',
        noApprovals: 'Nothing waiting for approval.',
        allowOnce: 'Allow once',
        reject: 'Reject',
        desktopOnly: 'Decide on the other device (no content hash)',
        refresh: 'Refresh',
        'status.online': 'Online',
        'status.connecting': 'Connecting',
        'status.offline': 'Offline',
        'status.revoked': 'Access revoked',
        'status.error': 'Error',
        error: 'Error',
        working: 'Working…',
        sent: 'Sent',
        enableFirst: 'Turn on "Allow connections" first.',
        'scope.harness:remote': 'Use this host remotely (sessions, prompts, approvals)',
        'scope.commands:execute': 'Run slash commands',
        'scope.workspace:manage': 'Manage workspaces and any path',
        'scope.credentials:write': 'Set or remove provider credentials',
        'scope.plugins:manage': 'Install and manage plugins',
        'scope.schedule:write': 'Create and run schedules',
        'scope.terminal': 'Open a terminal',
        // One short risk line per dangerous scope, shown under its checkbox.
        'risk.files:write': 'Can change files in your workspaces.',
        'risk.settings:write': 'Can change Host settings, models and agent presets.',
        'risk.commands:execute': 'Can run Host commands as you.',
        'risk.workspace:manage': 'Can create or delete workspaces and read files outside them.',
        'risk.credentials:write': 'Can overwrite your API keys (it cannot read them).',
        'risk.plugins:manage': 'Can install or enable code that runs on this Host.',
        'risk.schedule:write': 'Can create jobs that run later without you.',
        'risk.terminal': 'Full shell on this Host: it can do anything you can.',
        presetStandard: 'Standard',
        presetFull: 'Full control',
        presetFullHint: 'Every permission, including shell, plugins and credentials. Only for devices you fully trust.',
        presets: 'Presets',
        notRequested: 'Not requested by this device',
        advancedLimits: 'Advanced',
        limitsHelp: 'Optional per-device limits of the remote bridge. 0 means unlimited (the default). They are Host configuration (remoteBridgeLimits in the mobile-gateway plugin config) and cannot be changed from this page.',
        'limit.maxConnectionsPerDevice': 'Connections per device',
        'limit.maxStreamsPerDevice': 'Open streams per device',
        'limit.maxInflightPerDevice': 'Calls in flight per device',
        'limit.callsPerSecond': 'Calls per second per device',
        'limit.maxResultBytes': 'Largest one-shot result (bytes)',
        unlimited: 'unlimited',
        // --- spec 008 T036: the bind the listener really uses, read-only ---
        listeningOn: 'Listening on',
        listenerUp: 'Listener up',
        listenerDown: 'Listener off',
        listenerUnknown: 'unknown address',
        certPin: 'Certificate pin (SHA-256)',
        loopbackTitle: 'Only this machine can connect',
        loopbackWarning: 'The Host listens on a loopback address, so only this machine can reach it — a phone or another computer cannot connect. To change it, open Settings → Plugins → the mobile-gateway row → configuration → listen address (lanHost), and enter any private LAN address or any Tailscale address of this machine. The certificate pin does not change, so no new certificate is needed.',
        reachableTitle: 'Reachable from other machines',
        reachableNote: 'This Host accepts connections at',
        reachableTailscale: 'That is one of this machine\'s Tailscale addresses, so other devices on your tailnet can connect.',
        // --- spec 008: a listener port the OS dynamic range can hand to an outbound connection ---
        portRiskTitle: 'This port can be taken by the operating system',
        portRiskBody: 'The operating system can hand this port to an outgoing connection, so the listener may fail to bind at a random moment.',
        portRiskSafeBand: 'Ports 20000-39999 sit outside the dynamic range and are the safe band.',
        portRiskAuto: 'The gateway now moves to the next free port by itself when the bind fails, so this is not fatal.',
        portBusyTitle: 'The port is already taken',
        portBusyBody: 'Another program holds this port, or an outgoing connection already took the same port from the operating system dynamic range. That busy port is why the listener cannot bind.',
        // --- spec 008: the connection plan — bind the listener to one of this machine's own addresses ---
        planTitle: 'Connection plan',
        planHelp: 'Bind this machine\'s gateway to one of its own addresses. The Tailscale option uses this machine\'s tailnet address, so the devices on your tailnet can connect.',
        // The LAN option is the first private address the OS reports, in Node's
        // interface order — a VPN or virtual adapter can win over the physical LAN.
        planLanCaveat: 'LAN binds the first private address the operating system reports. A VPN or virtual adapter may be chosen before the physical LAN adapter; if that is not the address you want, use the Tailscale option or set the listen address in the gateway config.',
        planBound: 'Bound to',
        planPrivateHint: 'This is a private or virtual address, not necessarily your home LAN:',
        'plan.loopback': 'This machine only',
        'plan.lan': 'LAN',
        'plan.tailscale': 'Tailscale private network',
        planApplying: 'Applying…',
        planUnknown: 'Unknown — the gateway reports no address',
        planTailscaleUnavailable: 'No Tailscale interface detected on this machine.',
        otpTitle: 'Pairing code',
        otpHelp: 'Type this code on the other device together with this address. It works once, for 10 minutes, and you will still have to approve the request here.',
        otpNew: 'Generate pairing code',
        otpClose: 'Close',
        pendingTitle: 'Pending requests',
        pendingNone: 'No device is asking to connect.',
        pendingHelp: 'Check that the code below is the same one shown on the other device before you approve.',
        verifyCode: 'Verification code',
        approve: 'Approve',
        rejectRequest: 'Reject',
        requestedAt: 'Requested',
        fromIp: 'From',
        addTitle: 'Add device',
        addLan: 'LAN',
        addInternet: 'Internet',
        addInternetLater: 'Internet — later',
        addAddress: 'Address',
        addCode: 'Pairing code',
        addCodeHint: '8 digits, shown on the other device',
        addName: 'Display name',
        addNote: 'Pairing again may expand or reduce access. If no workspaces are available, check permissions under Authorized devices on that device.',
        addSubmit: 'Add device',
        advanced: 'Advanced: paste pairing string',
        advancedBack: 'Use the 8-digit code instead',
        waiting: 'Waiting for approval on the host',
        waitingCode: 'Code',
        waitingHelp: 'Approve this request on the other device after checking that it shows the same code.',
        cancelWait: 'Cancel',
        pairRejected: 'The host rejected this device.',
        pairApproved: 'Paired.',
        // --- spec 008 P2b: remote sessions inside the native UI ---
        groupLocal: 'Local workspaces',
        groupSearch: 'Search workspaces and sessions',
        groupNoMatches: 'Nothing matches.',
        groupNoWorkspaces: 'This host lists no workspace.',
        // A group can be empty for three different reasons; say which one it is.
        groupHostOffline: 'This host is not connected; its workspaces appear here once it reconnects.',
        groupHostRefused: 'The host refused the last request, so it lists no workspace',
        newSession: 'New session',
        newSessionIn: 'New session in this host',
        newSessionNeedsWorkspace: 'No workspace on this host to start a session in.',
        lastActivity: 'Last activity',
        pinSession: 'Pin session',
        unpinSession: 'Unpin session',
        archiveSession: 'Archive session',
        unarchiveSession: 'Unarchive session',
        archived: 'Archived',
        pinned: 'Pinned',
        unread: 'Unread',
        hostChip: 'Host',
        hostAlreadyShown: 'Host',
        popoverTitle: 'Remote host',
        popoverPaired: 'Paired',
        popoverKind: 'Type',
        popoverScopes: 'Permissions',
        popoverNoScopes: 'none',
        reconnect: 'Reconnect',
        reconnecting: 'Reconnecting…',
        forgetHost: 'Forget host',
        forgetConfirm: 'Forget this host? Its token is deleted from this machine and its workspaces leave the sidebar.',
        manageAll: 'Manage all devices in Settings → Devices',
        banners: 'Remote session notices',
        bannerOfflineTitle: 'This task is no longer available on',
        bannerOfflineBody: 'You are reading the local copy; it is read-only.',
        bannerReadOnly: 'Read-only',
        removeLocalCopy: 'Remove local copy',
        removeLocalCopyBusy: 'Removing…',
        localCopyRemoved: 'Local copy removed.',
        localCopyGone: 'There was no local copy to remove.',
        modelStatus: 'Model status',
        modelUnavailable: 'The host reports this model is unavailable. Prompts still run on the host; no local model is used instead.',
        terminalEntry: 'Terminal',
        terminalOpen: 'Open a terminal on this host',
        terminalHint: 'The terminal needs the "Open a terminal" permission on this device.',
        terminalUnavailable: 'The terminal is not available in this shell.',
        sidebarOff: 'Remote hosts cannot be shown here.',
        sidebarGrouping: 'Sidebar grouping',
        sidebarOn: 'grouped by host',
        sidebarOffState: 'off',
        // --- the grant is short: remote sessions/workspaces cannot appear (spec 008) ---
        missingRemoteScope: 'Remote sessions and workspaces cannot appear until this device is paired again on that host with the "Use this host remotely" (harness:remote) permission.',
        hostRefused: 'The host refused the last request',
      },
      vi: {
        title: 'Thiết bị',
        tabAllow: 'Cho phép kết nối tới thiết bị này',
        tabConnect: 'Kết nối tới thiết bị khác',
        allow: 'Cho phép kết nối',
        allowHelp: 'Cho phép các thiết bị khác trong mạng điều khiển Host DSH này sau khi ghép đôi. Tắt sẽ đóng mọi kết nối.',
        lan: 'Mạng nội bộ (LAN)',
        internet: 'Internet',
        internetLater: 'Sau này — chưa khả dụng',
        generate: 'Tạo mã ghép đôi',
        pairingCode: 'Mã ghép đôi',
        pairingHelp: 'Dán mã này trên thiết bị kia. Chỉ dùng được một lần và sớm hết hạn.',
        copy: 'Sao chép',
        copied: 'Đã sao chép',
        expiresIn: 'Hết hạn sau',
        expired: 'Đã hết hạn — hãy tạo mã mới',
        address: 'Địa chỉ của thiết bị này',
        noAddress: 'Chưa có địa chỉ truy cập. Hãy bật "Cho phép kết nối".',
        authorized: 'Thiết bị được cấp quyền',
        noAuthorized: 'Chưa có thiết bị nào được cấp quyền.',
        kind: 'Loại',
        scopes: 'Quyền',
        lastUsed: 'Dùng lần cuối',
        never: 'chưa bao giờ',
        connectedHere: 'Đang kết nối',
        remove: 'Gỡ quyền truy cập',
        removeConfirm: 'Gỡ quyền truy cập của thiết bị này? Thiết bị sẽ bị ngắt ngay.',
        edit: 'Sửa quyền',
        editHelp: 'Quyền được cố định khi thiết bị ghép đôi. Lưu sẽ tạo mã ghép đôi mới với các quyền đã chọn; thiết bị phải ghép đôi lại và kết nối hiện tại sẽ bị đóng.',
        editSave: 'Tạo mã ghép đôi mới',
        cancel: 'Hủy',
        'scope.sessions:read': 'Xem phiên và lịch sử',
        'scope.prompt:send': 'Gửi prompt',
        'scope.approval:respond': 'Trả lời yêu cầu phê duyệt',
        'scope.files:read': 'Đọc tệp',
        'scope.files:write': 'Ghi tệp',
        'scope.settings:write': 'Đổi cài đặt',
        addDevice: 'Thêm thiết bị',
        addressLabel: 'Địa chỉ (ip:port)',
        pairingLabel: 'Chuỗi ghép đôi',
        nameLabel: 'Tên (tùy chọn)',
        connect: 'Ghép đôi và kết nối',
        remotes: 'Host từ xa',
        noRemotes: 'Chưa có host từ xa nào.',
        open: 'Mở',
        back: 'Quay lại',
        removeRemote: 'Gỡ',
        sessions: 'Phiên',
        noSessions: 'Host này chưa có phiên nào.',
        history: 'Lịch sử',
        noHistory: 'Không có tin nhắn.',
        prompt: 'Gửi prompt',
        send: 'Gửi',
        approvals: 'Yêu cầu phê duyệt đang chờ',
        noApprovals: 'Không có yêu cầu nào đang chờ.',
        allowOnce: 'Cho phép một lần',
        reject: 'Từ chối',
        desktopOnly: 'Hãy quyết định trên thiết bị kia (không có mã băm nội dung)',
        refresh: 'Làm mới',
        'status.online': 'Trực tuyến',
        'status.connecting': 'Đang kết nối',
        'status.offline': 'Ngoại tuyến',
        'status.revoked': 'Đã bị thu hồi quyền',
        'status.error': 'Lỗi',
        error: 'Lỗi',
        working: 'Đang xử lý…',
        sent: 'Đã gửi',
        enableFirst: 'Hãy bật "Cho phép kết nối" trước.',
        'scope.harness:remote': 'Dùng host này từ xa (phiên, prompt, phê duyệt)',
        'scope.commands:execute': 'Chạy lệnh slash',
        'scope.workspace:manage': 'Quản lý workspace và mọi đường dẫn',
        'scope.credentials:write': 'Đặt hoặc xóa thông tin xác thực nhà cung cấp',
        'scope.plugins:manage': 'Cài đặt và quản lý plugin',
        'scope.schedule:write': 'Tạo và chạy lịch',
        'scope.terminal': 'Mở terminal',
        'risk.files:write': 'Có thể sửa tệp trong workspace của bạn.',
        'risk.settings:write': 'Có thể đổi cài đặt Host, model và preset agent.',
        'risk.commands:execute': 'Có thể chạy lệnh của Host với quyền của bạn.',
        'risk.workspace:manage': 'Có thể tạo hoặc xóa workspace và đọc tệp ngoài workspace.',
        'risk.credentials:write': 'Có thể ghi đè khóa API của bạn (không đọc được).',
        'risk.plugins:manage': 'Có thể cài hoặc bật mã chạy trên Host này.',
        'risk.schedule:write': 'Có thể tạo tác vụ chạy sau mà không cần bạn.',
        'risk.terminal': 'Toàn quyền shell trên Host này: làm được mọi việc bạn làm được.',
        presetStandard: 'Tiêu chuẩn',
        presetFull: 'Toàn quyền',
        presetFullHint: 'Mọi quyền, gồm shell, plugin và thông tin xác thực. Chỉ dùng cho thiết bị bạn hoàn toàn tin cậy.',
        presets: 'Mẫu quyền',
        notRequested: 'Thiết bị này không yêu cầu',
        advancedLimits: 'Nâng cao',
        limitsHelp: 'Giới hạn tùy chọn cho mỗi thiết bị của cầu nối từ xa. 0 nghĩa là không giới hạn (mặc định). Đây là cấu hình Host (remoteBridgeLimits trong cấu hình plugin mobile-gateway), không đổi được từ trang này.',
        'limit.maxConnectionsPerDevice': 'Số kết nối mỗi thiết bị',
        'limit.maxStreamsPerDevice': 'Số luồng mở mỗi thiết bị',
        'limit.maxInflightPerDevice': 'Số lệnh đang chạy mỗi thiết bị',
        'limit.callsPerSecond': 'Số lệnh mỗi giây mỗi thiết bị',
        'limit.maxResultBytes': 'Kết quả một lần lớn nhất (byte)',
        unlimited: 'không giới hạn',
        // --- spec 008 T036: địa chỉ lắng nghe thực tế, chỉ đọc ---
        listeningOn: 'Đang lắng nghe trên',
        listenerUp: 'Đang bật',
        listenerDown: 'Đang tắt',
        listenerUnknown: 'chưa rõ địa chỉ',
        certPin: 'Mã ghim chứng chỉ (SHA-256)',
        loopbackTitle: 'Chỉ máy này kết nối được',
        loopbackWarning: 'Host đang lắng nghe trên địa chỉ loopback, nên chỉ máy này truy cập được — điện thoại hay máy khác không kết nối được. Để đổi, mở Cài đặt → Plugin → mục mobile-gateway → cấu hình → địa chỉ lắng nghe (lanHost), và nhập một địa chỉ LAN nội bộ hoặc địa chỉ Tailscale của máy này. Mã ghim chứng chỉ không đổi, nên không cần tạo chứng chỉ mới.',
        reachableTitle: 'Máy khác có thể kết nối',
        reachableNote: 'Host này nhận kết nối tại',
        reachableTailscale: 'Đây là một địa chỉ Tailscale của máy này, nên các thiết bị khác trong tailnet của bạn kết nối được.',
        // --- spec 008: cổng mà dải động của hệ điều hành có thể cấp cho kết nối đi ra ---
        portRiskTitle: 'Cổng này có thể bị hệ điều hành lấy mất',
        portRiskBody: 'Hệ điều hành có thể cấp cổng này cho một kết nối đi ra, nên listener có thể không bind được vào một lúc ngẫu nhiên.',
        portRiskSafeBand: 'Cổng 20000-39999 nằm ngoài dải động và là dải an toàn.',
        portRiskAuto: 'Gateway giờ tự chuyển sang cổng trống kế tiếp khi bind thất bại, nên đây không phải lỗi nghiêm trọng.',
        portBusyTitle: 'Cổng đã bị chiếm',
        portBusyBody: 'Một chương trình khác đang giữ cổng này, hoặc một kết nối đi ra đã lấy đúng cổng đó từ dải động của hệ điều hành. Cổng bị chiếm là lý do listener không bind được.',
        // --- spec 008: kế hoạch kết nối — gắn listener vào một địa chỉ của chính máy này ---
        planTitle: 'Kế hoạch kết nối',
        planHelp: 'Gắn gateway của máy này vào một địa chỉ của chính nó. Tuỳ chọn Tailscale dùng địa chỉ tailnet của máy này, nên các thiết bị trong tailnet của bạn kết nối được.',
        planLanCaveat: 'LAN gắn vào địa chỉ riêng đầu tiên mà hệ điều hành báo cáo. Một adapter VPN hoặc mạng ảo có thể được chọn trước adapter LAN thật; nếu đó không phải địa chỉ bạn muốn, hãy dùng tuỳ chọn Tailscale hoặc đặt địa chỉ lắng nghe trong cấu hình gateway.',
        planBound: 'Đang lắng nghe tại',
        planPrivateHint: 'Đây là địa chỉ riêng hoặc mạng ảo, không hẳn là LAN trong nhà bạn:',
        'plan.loopback': 'Chỉ máy này',
        'plan.lan': 'LAN',
        'plan.tailscale': 'Mạng riêng Tailscale',
        planApplying: 'Đang áp dụng…',
        planUnknown: 'Chưa rõ — gateway chưa báo địa chỉ',
        planTailscaleUnavailable: 'Không phát hiện giao diện Tailscale trên máy này.',
        otpTitle: 'Mã ghép đôi',
        otpHelp: 'Nhập mã này trên thiết bị kia cùng với địa chỉ này. Chỉ dùng một lần, trong 10 phút, và bạn vẫn phải phê duyệt yêu cầu tại đây.',
        otpNew: 'Tạo mã ghép đôi',
        otpClose: 'Đóng',
        pendingTitle: 'Yêu cầu đang chờ',
        pendingNone: 'Không có thiết bị nào đang xin kết nối.',
        pendingHelp: 'Hãy kiểm tra mã bên dưới trùng với mã hiển thị trên thiết bị kia trước khi phê duyệt.',
        verifyCode: 'Mã xác minh',
        approve: 'Phê duyệt',
        rejectRequest: 'Từ chối',
        requestedAt: 'Yêu cầu lúc',
        fromIp: 'Từ',
        addTitle: 'Thêm thiết bị',
        addLan: 'LAN',
        addInternet: 'Internet',
        addInternetLater: 'Internet — sau này',
        addAddress: 'Địa chỉ',
        addCode: 'Mã ghép đôi',
        addCodeHint: '8 chữ số, hiển thị trên thiết bị kia',
        addName: 'Tên hiển thị',
        addNote: 'Ghép đôi lại có thể mở rộng hoặc thu hẹp quyền truy cập. Nếu không có workspace nào, hãy kiểm tra quyền trong mục Thiết bị được cấp quyền trên thiết bị kia.',
        addSubmit: 'Thêm thiết bị',
        advanced: 'Nâng cao: dán chuỗi ghép đôi',
        advancedBack: 'Dùng mã 8 chữ số',
        waiting: 'Đang chờ phê duyệt trên host',
        waitingCode: 'Mã',
        waitingHelp: 'Hãy phê duyệt yêu cầu này trên thiết bị kia sau khi kiểm tra nó hiển thị cùng một mã.',
        cancelWait: 'Hủy',
        pairRejected: 'Host đã từ chối thiết bị này.',
        pairApproved: 'Đã ghép đôi.',
        // --- spec 008 P2b: phiên từ xa trong giao diện gốc ---
        groupLocal: 'Workspace trên máy này',
        groupSearch: 'Tìm workspace và phiên',
        groupNoMatches: 'Không có kết quả.',
        groupNoWorkspaces: 'Host này không có workspace nào.',
        groupHostOffline: 'Host này chưa kết nối. Workspace sẽ hiện ra khi kết nối lại.',
        groupHostRefused: 'Host đã từ chối yêu cầu vừa rồi nên chưa hiện được workspace nào',
        newSession: 'Phiên mới',
        newSessionIn: 'Phiên mới trên host này',
        newSessionNeedsWorkspace: 'Host này chưa có workspace để mở phiên.',
        lastActivity: 'Hoạt động cuối',
        pinSession: 'Ghim phiên',
        unpinSession: 'Bỏ ghim phiên',
        archiveSession: 'Lưu trữ phiên',
        unarchiveSession: 'Bỏ lưu trữ phiên',
        archived: 'Đã lưu trữ',
        pinned: 'Đã ghim',
        unread: 'Chưa đọc',
        hostChip: 'Host',
        hostAlreadyShown: 'Host',
        popoverTitle: 'Host từ xa',
        popoverPaired: 'Ghép đôi lúc',
        popoverKind: 'Loại',
        popoverScopes: 'Quyền',
        popoverNoScopes: 'không có',
        reconnect: 'Kết nối lại',
        reconnecting: 'Đang kết nối lại…',
        forgetHost: 'Gỡ host',
        forgetConfirm: 'Gỡ host này? Token của nó sẽ bị xóa khỏi máy này và workspace của nó rời khỏi thanh bên.',
        manageAll: 'Quản lý mọi thiết bị trong Cài đặt → Thiết bị',
        banners: 'Thông báo phiên từ xa',
        bannerOfflineTitle: 'Tác vụ này không còn trên',
        bannerOfflineBody: 'Bạn đang đọc bản sao cục bộ; nó chỉ đọc.',
        bannerReadOnly: 'Chỉ đọc',
        removeLocalCopy: 'Xóa bản sao cục bộ',
        removeLocalCopyBusy: 'Đang xóa…',
        localCopyRemoved: 'Đã xóa bản sao cục bộ.',
        localCopyGone: 'Không có bản sao cục bộ nào để xóa.',
        modelStatus: 'Trạng thái model',
        modelUnavailable: 'Host báo model này không khả dụng. Prompt vẫn chạy trên host; không dùng model cục bộ thay thế.',
        terminalEntry: 'Terminal',
        terminalOpen: 'Mở terminal trên host này',
        terminalHint: 'Terminal cần quyền "Mở terminal" trên thiết bị này.',
        terminalUnavailable: 'Terminal không khả dụng trong giao diện này.',
        sidebarOff: 'Không thể hiển thị host từ xa ở đây.',
        sidebarGrouping: 'Nhóm thanh bên',
        sidebarOn: 'nhóm theo host',
        sidebarOffState: 'tắt',
        // --- thiếu quyền: phiên và workspace từ xa không hiển thị được (spec 008) ---
        missingRemoteScope: 'Phiên và workspace từ xa sẽ không hiện ra cho tới khi thiết bị này được ghép đôi lại trên host đó kèm quyền "Dùng host này từ xa" (harness:remote).',
        hostRefused: 'Host đã từ chối yêu cầu vừa rồi',
      },
    }
    let hostLanguage = ''
    const listeners = new Set()
    const currentLang = () => (/^vi/i.test(hostLanguage || (typeof navigator !== 'undefined' ? navigator.language : '') || '') ? 'vi' : 'en')
    const tr = (key) => DICT[currentLang()][key] ?? DICT.en[key] ?? key
    const subscribeLang = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
    const langSnapshot = () => currentLang()
    const setHostLanguage = (value) => {
      const before = currentLang()
      hostLanguage = value || ''
      if (before !== currentLang()) for (const listener of listeners) listener()
    }
    const useLang = () => React.useSyncExternalStore(subscribeLang, langSnapshot)

    // ------------------------------------------------------------- helpers
    // Same-origin only; honours the <base> prefix the way the gateway does.
    async function request(path, options) {
      const target = new URL(path.replace(/^\//, ''), document.baseURI).href
      const response = await fetch(target, { credentials: 'same-origin', ...options })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`)
      return body
    }
    const post = (path, body) => request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
    })
    async function copyText(text) {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('clipboard unavailable')
      }
      await navigator.clipboard.writeText(text)
    }
    const colors = {
      panel: 'var(--dsw-alias-bg-layer-2, var(--color-bg, Canvas))',
      card: 'var(--dsw-alias-bg-module-platform, var(--color-bg-elevated, Canvas))',
      text: 'var(--dsw-alias-label-primary, var(--color-text, CanvasText))',
      muted: 'var(--dsw-alias-label-secondary, var(--color-text-muted, GrayText))',
      border: 'var(--dsw-alias-border-l3, var(--color-border, rgba(127,127,127,.24)))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08))',
      accent: 'var(--dsw-alias-button-primary-fill, var(--color-primary, #4f7cff))',
      accentText: 'var(--dsw-alias-label-primary-foreground, #fff)',
      danger: 'var(--dsw-alias-state-error-primary, #dc4c64)',
      success: 'var(--dsw-alias-state-success-primary, #2fb171)',
    }
    const css = `
.dshdev{font-family:var(--dsw-font-family,system-ui,sans-serif);font-size:13px;color:${colors.text};max-width:880px}
.dshdev h2{margin:0 0 14px;font-size:20px;font-weight:650}
.dshdev h3{margin:0 0 8px;font-size:14px;font-weight:600}
.dshdev-tabs{display:flex;gap:4px;border-bottom:1px solid ${colors.border};margin-bottom:16px}
.dshdev-tab{background:transparent;border:0;border-bottom:2px solid transparent;color:${colors.muted};cursor:pointer;font:inherit;padding:8px 12px}
.dshdev-tab[aria-selected=true]{color:${colors.text};border-bottom-color:${colors.accent};font-weight:600}
.dshdev-card{background:${colors.card};border:1px solid ${colors.border};border-radius:var(--dsw-radius-panel,12px);padding:14px 16px;margin-bottom:14px}
.dshdev-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshdev-grow{flex:1;min-width:0}
.dshdev-muted{color:${colors.muted};font-size:12px}
.dshdev-btn{background:transparent;border:1px solid ${colors.border};border-radius:8px;color:inherit;cursor:pointer;font:inherit;padding:5px 12px}
.dshdev-btn:hover:not(:disabled){background:${colors.hover}}
.dshdev-btn:disabled{opacity:.5;cursor:default}
.dshdev-btn.primary{background:${colors.accent};border-color:${colors.accent};color:${colors.accentText}}
.dshdev-btn.danger{color:${colors.danger};border-color:${colors.danger}}
.dshdev-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid ${colors.border};border-radius:999px;padding:3px 6px 3px 10px;font-family:ui-monospace,monospace;font-size:12px}
.dshdev-badge{border-radius:999px;padding:1px 8px;font-size:11px;border:1px solid ${colors.border};color:${colors.muted}}
.dshdev-badge.ok{color:${colors.success};border-color:${colors.success}}
.dshdev-badge.bad{color:${colors.danger};border-color:${colors.danger}}
.dshdev-input{box-sizing:border-box;width:100%;background:transparent;border:1px solid ${colors.border};border-radius:8px;color:inherit;font:inherit;padding:6px 10px}
.dshdev-code{display:block;word-break:break-all;font-family:ui-monospace,monospace;font-size:12px;background:${colors.hover};border-radius:8px;padding:8px 10px;max-height:120px;overflow:auto}
.dshdev-list>div{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid ${colors.border};flex-wrap:wrap}
.dshdev-list>div:first-child{border-top:0}
.dshdev-switch{position:relative;width:38px;height:22px;border-radius:999px;border:0;cursor:pointer;background:rgba(127,127,127,.4);padding:0;flex:none}
.dshdev-switch[aria-checked=true]{background:${colors.accent}}
.dshdev-switch::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .12s}
.dshdev-switch[aria-checked=true]::after{left:19px}
.dshdev-switch:disabled{opacity:.5;cursor:default}
.dshdev-err{color:${colors.danger};margin:8px 0}
/* A short grant: visible on the remote's own row, but it blocks nothing. */
.dshdev-warn{margin-top:6px;padding:6px 10px;border-left:3px solid ${colors.danger};border-radius:6px;background:${colors.hover};color:${colors.text};font-size:12px}
.dshdev-msg{margin:6px 0;padding:8px 10px;border-radius:8px;background:${colors.hover};white-space:pre-wrap;word-break:break-word}
.dshdev-msg.user{border-left:3px solid ${colors.accent}}
.dshdev-otp{font-family:ui-monospace,monospace;font-size:34px;font-weight:700;letter-spacing:.12em;text-align:center;padding:14px 0}
.dshdev-vcode{font-family:ui-monospace,monospace;font-size:30px;font-weight:700;letter-spacing:.14em}
.dshdev-dialog-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000}
.dshdev-dialog{background:${colors.panel};color:${colors.text};border:1px solid ${colors.border};border-radius:14px;padding:20px 22px;width:min(460px,92vw);max-height:90vh;overflow:auto}
.dshdev-seg{display:inline-flex;border:1px solid ${colors.border};border-radius:8px;overflow:hidden}
.dshdev-seg button{background:transparent;border:0;color:inherit;font:inherit;padding:5px 14px;cursor:pointer}
.dshdev-seg button[aria-pressed=true]{background:${colors.accent};color:${colors.accentText}}
.dshdev-seg button:disabled{opacity:.5;cursor:default}
/* spec 008 P2b: the host-grouped sidebar, the composer chip/popover and the notices. */
.dshdev-side{display:flex;flex-direction:column;gap:2px;font-size:13px;color:${colors.text}}
.dshdev-side-search{box-sizing:border-box;width:100%;background:transparent;border:1px solid ${colors.border};border-radius:8px;color:inherit;font:inherit;padding:4px 8px;margin-bottom:6px}
.dshdev-side-group{margin-bottom:8px;min-width:0}
.dshdev-side-head{display:flex;align-items:center;gap:6px;padding:2px 2px;color:${colors.muted};font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.dshdev-side-head strong{color:${colors.text};font-size:11px;text-transform:none;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdev-side-ws{padding:2px 2px 2px 8px;color:${colors.muted};font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdev-side-session{display:flex;align-items:center;gap:6px;padding:2px 4px 2px 16px;border-radius:6px;min-width:0}
.dshdev-side-session:hover{background:${colors.hover}}
.dshdev-side-title{flex:1;min-width:0;background:transparent;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdev-side-meta{color:${colors.muted};font-size:11px;flex:none}
.dshdev-dot{width:7px;height:7px;border-radius:50%;flex:none;background:${colors.muted};display:inline-block}
.dshdev-dot.ok{background:${colors.success}}
.dshdev-dot.off{background:${colors.danger}}
.dshdev-side-action{background:transparent;border:0;color:${colors.muted};cursor:pointer;font:inherit;font-size:11px;padding:0 3px;flex:none}
.dshdev-side-action:hover{color:${colors.text}}
.dshdev-side-new{background:transparent;border:0;color:${colors.muted};cursor:pointer;font:inherit;font-size:13px;line-height:1;padding:0 4px;flex:none}
.dshdev-side-new:hover{color:${colors.text}}
.dshdev-chip-host{display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid ${colors.border};border-radius:999px;color:inherit;cursor:pointer;font:inherit;font-size:12px;padding:2px 10px;max-width:220px}
.dshdev-chip-host:hover{background:${colors.hover}}
.dshdev-chip-host span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdev-pop{position:absolute;bottom:calc(100% + 8px);left:0;z-index:20;width:min(320px,80vw);background:${colors.panel};color:${colors.text};border:1px solid ${colors.border};border-radius:12px;padding:12px 14px;box-shadow:0 8px 24px rgba(0,0,0,.18);text-align:left}
.dshdev-pop-row{display:flex;gap:8px;align-items:baseline;justify-content:space-between;margin:4px 0}
.dshdev-pop-row span:first-child{color:${colors.muted};font-size:11px;flex:none}
.dshdev-pop-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.dshdev-anchor{position:relative;display:inline-flex}
.dshdev-dock{display:flex;flex-direction:column;gap:6px;margin-bottom:6px}
.dshdev-banner{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;border:1px solid ${colors.border};border-left:3px solid ${colors.danger};border-radius:8px;padding:8px 10px;background:${colors.card}}
.dshdev-banner.info{border-left-color:${colors.accent}}
.dshdev-banner strong{display:block;font-weight:600}
`

    // --------------------------------------------------------- small widgets
    function CopyButton({ text, label }) {
      const [done, setDone] = React.useState(false)
      useLang()
      return h('button', {
        type: 'button', className: 'dshdev-btn',
        onClick: async () => {
          try { await copyText(text); setDone(true); window.setTimeout(() => setDone(false), 1800) } catch { setDone(false) }
        },
      }, done ? tr('copied') : (label || tr('copy')))
    }

    function Countdown({ expiresAt }) {
      const [now, setNow] = React.useState(() => Date.now())
      useLang()
      React.useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [])
      const left = Math.max(0, Math.round((expiresAt - now) / 1000))
      if (left <= 0) return h('span', { className: 'dshdev-badge bad' }, tr('expired'))
      return h('span', { className: 'dshdev-badge' }, `${tr('expiresIn')} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)
    }

    function PairingBox({ pairing, onClose }) {
      useLang()
      return h('div', { className: 'dshdev-card' },
        h('div', { className: 'dshdev-row' },
          h('h3', { className: 'dshdev-grow' }, tr('pairingCode')),
          h(Countdown, { expiresAt: pairing.pairing.expiresAt }),
          h(CopyButton, { text: pairing.pairingString }),
          onClose ? h('button', { type: 'button', className: 'dshdev-btn', onClick: onClose }, tr('cancel')) : null),
        h('code', { className: 'dshdev-code', 'data-testid': 'pairing-string' }, pairing.pairingString),
        h('div', { className: 'dshdev-muted', style: { marginTop: 6 } }, tr('pairingHelp')))
    }

    // ------------------------------------------------- spec 008 P1b widgets
    function Dialog({ title, onClose, children }) {
      return h('div', { className: 'dshdev-dialog-backdrop', role: 'presentation' },
        h('div', { className: 'dshdev-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': title },
          h('div', { className: 'dshdev-row', style: { marginBottom: 10 } },
            h('h3', { className: 'dshdev-grow', style: { margin: 0 } }, title),
            onClose ? h('button', { type: 'button', className: 'dshdev-btn', 'aria-label': tr('otpClose'), onClick: onClose }, '×') : null),
          children))
    }
    const groupOtp = (otp) => String(otp || '').replace(/^(\d{4})(\d{4})$/, '$1 $2')

    // Window 1: the one-time code, its countdown and the addresses to type.
    function OtpDialog({ offer, addresses, onClose }) {
      useLang()
      return h(Dialog, { title: tr('otpTitle'), onClose },
        h('div', { className: 'dshdev-otp', 'data-testid': 'otp-code' }, groupOtp(offer.otp)),
        h('div', { className: 'dshdev-row', style: { justifyContent: 'center', marginBottom: 8 } },
          h(Countdown, { expiresAt: offer.pairing.expiresAt }),
          h(CopyButton, { text: String(offer.otp) })),
        h('div', { className: 'dshdev-muted', style: { marginBottom: 10 } }, tr('otpHelp')),
        h('h3', null, tr('address')),
        addresses.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('noAddress'))
          : h('div', { className: 'dshdev-row' }, addresses.map((address) =>
            h('span', { key: address, className: 'dshdev-chip' }, address, h(CopyButton, { text: address })))))
    }

    // Every desktop scope, safest first. client.js is a plain script (it cannot
    // import packages/mobile-protocol), so these mirror the contract's SCOPES and
    // SCOPE_PRESETS; client.test.mjs fails if they drift.
    const ALL_SCOPES = [
      'sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote',
      'files:write', 'settings:write', 'commands:execute', 'workspace:manage',
      'credentials:write', 'plugins:manage', 'schedule:write', 'terminal',
    ]
    const SCOPE_PRESETS = {
      standard: ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote'],
      full: [...ALL_SCOPES],
    }
    // Scopes that get a risk hint under their checkbox.
    const RISKY_SCOPES = new Set(['files:write', 'settings:write', 'commands:execute', 'workspace:manage',
      'credentials:write', 'plugins:manage', 'schedule:write', 'terminal'])
    const keepKnown = (scopes) => ALL_SCOPES.filter((scope) => scopes.includes(scope))

    // The checkbox list + the two preset buttons, shared by Approve and Edit permissions.
    // `allowed` (Approve only): the scopes the pairing request offered. The gateway
    // refuses an Approve that is wider than the offer, so the rest stay listed but
    // disabled and the presets are cut to the offer.
    function ScopePicker({ scopes, onChange, allowed }) {
      useLang()
      const can = (scope) => !allowed || allowed.includes(scope)
      const preset = (name) => onChange(keepKnown(SCOPE_PRESETS[name].filter(can)))
      return h('div', { 'data-testid': 'scope-picker' },
        h('div', { className: 'dshdev-row', style: { margin: '6px 0' } },
          h('span', { className: 'dshdev-muted' }, tr('presets')),
          h('button', { type: 'button', className: 'dshdev-btn', onClick: () => preset('standard') }, tr('presetStandard')),
          h('button', { type: 'button', className: 'dshdev-btn danger', title: tr('presetFullHint'), onClick: () => preset('full') }, tr('presetFull'))),
        ALL_SCOPES.map((scope) => h('label', { key: scope, className: 'dshdev-row', style: { alignItems: 'flex-start', opacity: can(scope) ? 1 : 0.5 } },
          h('input', {
            type: 'checkbox', checked: scopes.includes(scope), disabled: !can(scope),
            onChange: (event) => onChange(keepKnown(event.target.checked ? [...scopes, scope] : scopes.filter((value) => value !== scope))),
          }),
          h('span', null, tr(`scope.${scope}`),
            RISKY_SCOPES.has(scope) ? h('span', { className: 'dshdev-muted', style: { display: 'block' } }, tr(`risk.${scope}`)) : null,
            can(scope) ? null : h('span', { className: 'dshdev-muted', style: { display: 'block' } }, tr('notRequested'))))))
    }

    // Window 2: who is asking, what for, and the code to compare. Polled every 2 s.
    function PendingRequests({ active }) {
      useLang()
      const [list, setList] = React.useState([])
      const [picked, setPicked] = React.useState({}) // request id -> scopes the owner keeps
      const [error, setError] = React.useState('')
      const mounted = React.useRef(true)
      const refresh = React.useCallback(async () => {
        try {
          const data = await request('/mgw/pending')
          if (!mounted.current) return
          setList(data.pending || [])
          setError('')
        } catch (cause) { if (mounted.current) setError(cause.message) }
      }, [])
      React.useEffect(() => {
        mounted.current = true
        if (!active) return undefined
        refresh()
        const timer = window.setInterval(refresh, 2000)
        return () => { mounted.current = false; window.clearInterval(timer) }
      }, [refresh, active])
      // Approve defaults to the Standard preset, limited to what the device asked
      // for (the gateway refuses anything wider). Anything dangerous is opt-in.
      const scopesOf = (item) => picked[item.id]
        || keepKnown(SCOPE_PRESETS.standard.filter((scope) => item.requestedScopes.includes(scope)))
      const pickScopes = (item, scopes) => setPicked({ ...picked, [item.id]: scopes })
      const decide = async (item, action) => {
        try {
          // Approve sends only the scopes the owner kept (the gateway refuses anything wider).
          await post(`/mgw/pending/${encodeURIComponent(item.id)}/${action}`, action === 'approve' ? { scopes: scopesOf(item) } : {})
          await refresh()
        } catch (cause) { setError(cause.message); refresh() }
      }
      return h('div', { className: 'dshdev-card', 'data-testid': 'pending-requests' },
        h('h3', null, tr('pendingTitle')),
        error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
        list.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('pendingNone'))
          : h('div', { className: 'dshdev-list' }, list.map((item) => h('div', { key: item.id, 'data-testid': 'pending-item' },
            h('div', { className: 'dshdev-grow' },
              h('div', { className: 'dshdev-row' }, h('strong', null, item.name), h('span', { className: 'dshdev-badge' }, item.kind)),
              h('div', { className: 'dshdev-muted' }, `${tr('fromIp')}: ${item.clientIp} · ${tr('requestedAt')}: ${new Date(item.createdAt).toLocaleTimeString()}`),
              h('div', { className: 'dshdev-muted', style: { marginTop: 8 } }, tr('verifyCode')),
              h('div', { className: 'dshdev-vcode', 'data-testid': 'verification-code' }, String(item.verificationCode).replace(/^(\d{3})(\d{3})$/, '$1 $2')),
              // All desktop scopes are listed; the gateway refuses what the device did not request.
              h('div', { style: { marginTop: 6 } }, h(ScopePicker, { scopes: scopesOf(item), allowed: item.requestedScopes, onChange: (scopes) => pickScopes(item, scopes) }))),
            h('button', { type: 'button', className: 'dshdev-btn primary', onClick: () => decide(item, 'approve') }, tr('approve')),
            h('button', { type: 'button', className: 'dshdev-btn danger', onClick: () => decide(item, 'reject') }, tr('rejectRequest'))))),
        list.length ? h('div', { className: 'dshdev-muted', style: { marginTop: 6 } }, tr('pendingHelp')) : null)
    }
    // ------------------------------------------------------ tab 1: allow
    // Advanced: the remote-bridge limits in force. Read-only: they are the
    // mobile-gateway plugin config (`remoteBridgeLimits`); /mgw has no write route
    // for it, so this page shows them and says where to change them.
    const LIMIT_KEYS = ['maxConnectionsPerDevice', 'maxStreamsPerDevice', 'maxInflightPerDevice', 'callsPerSecond', 'maxResultBytes']
    function AdvancedLimits({ limits }) {
      useLang()
      const [open, setOpen] = React.useState(false)
      return h('div', { className: 'dshdev-card', 'data-testid': 'advanced-limits' },
        h('div', { className: 'dshdev-row' },
          h('h3', { className: 'dshdev-grow', style: { margin: 0 } }, tr('advancedLimits')),
          h('button', { type: 'button', className: 'dshdev-btn', 'aria-expanded': open, onClick: () => setOpen(!open) }, open ? '−' : '+')),
        open ? h('div', { style: { marginTop: 8 } },
          h('div', { className: 'dshdev-muted', style: { marginBottom: 8 } }, tr('limitsHelp')),
          h('div', { className: 'dshdev-list' }, LIMIT_KEYS.map((key) => {
            const value = limits && Number.isSafeInteger(limits[key]) ? limits[key] : 0
            return h('div', { key },
              h('div', { className: 'dshdev-grow' }, tr(`limit.${key}`)),
              h('strong', { 'data-testid': `limit-${key}` }, value === 0 ? `0 (${tr('unlimited')})` : String(value)))
          }))) : null)
    }

    // Spec 008 T036: where the listener really binds. The address is the
    // mobile-gateway plugin CONFIG (`lanHost`), not a route this page can change,
    // so the page states the real bind and — when it is a loopback bind — says
    // plainly that no other machine can connect and where the owner changes it.
    // Read-only: it renders the /mgw/status the tab already polls.
    const LOOPBACK_HOST = /^(?:localhost|::1|0:0:0:0:0:0:0:1|127\..*)$/i
    const isLoopbackHost = (host) => LOOPBACK_HOST.test(String(host || '').replace(/^\[|\]$/g, ''))
    // `lan.urls[0]` already carries the TLS scheme; without one the bind is host:port.
    const listenerBind = (lan) => {
      const urls = (lan && lan.urls) || []
      if (urls.length > 0) return String(urls[0])
      const host = lan && lan.host
      return host ? (lan.port ? `${host}:${lan.port}` : String(host)) : ''
    }
    // A pin is a SHA-256 fingerprint — too long to read at a glance. One helper,
    // used only here; the full value stays in `title` because it is what a client pins.
    const shortenHash = (value) => {
      const full = String(value || '')
      return full.length <= 29 ? full : `${full.slice(0, 17)}…${full.slice(-11)}`
    }
    // A listener inside the OS dynamic (ephemeral) port range competes with the
    // source port of an outbound connection, so its bind can fail at a random
    // moment. The boundaries are the measured range on the machine this was built
    // for (1024-15000 inclusive) and the Windows default (49152-65535 inclusive),
    // not a universal guarantee — 15001-49151 stays quiet because neither range
    // covers it.
    const RISKY_PORT_BELOW = 15000
    const RISKY_PORT_ABOVE = 49152
    const isRiskyListenerPort = (port) => Number.isInteger(port) && port > 0 &&
      (port <= RISKY_PORT_BELOW || port >= RISKY_PORT_ABOVE)

    // The three plans this build can really apply, and the only targets
    // POST /mgw/listen accepts. Cloudflare/P2P are hard-disabled in this fork, so
    // they are not offered: a dead option in a dropdown is a lie.
    const PLAN_TARGETS = ['loopback', 'lan', 'tailscale']
    // Tailscale hands out 100.64.0.0/10 (CGNAT); IPv6 tailnet addresses only ever
    // come from `tailscale.addresses`, which the gateway itself detected.
    const TAILSCALE_IPV4 = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/
    const isTailscaleHost = (host, addresses) => {
      const value = String(host || '').replace(/^\[|\]$/g, '')
      if (!value) return false
      if (TAILSCALE_IPV4.test(value)) return true
      return (addresses || []).some((address) => String(address).replace(/^\[|\]$/g, '') === value)
    }
    // The current plan is DERIVED from status, never remembered: the select must
    // not be able to show a plan the listener is not on. '' = status says nothing,
    // which disables the control instead of guessing.
    const planOf = (status) => {
      const host = status && status.lan && typeof status.lan.host === 'string' ? status.lan.host : ''
      if (!host) return ''
      if (isLoopbackHost(host)) return 'loopback'
      return isTailscaleHost(host, status.tailscale && status.tailscale.addresses) ? 'tailscale' : 'lan'
    }

    // The connection plan used to be static plugin config (`lanHost`), which meant
    // editing config and restarting to reach this machine over Tailscale. This is
    // the one write on the tab: POST /mgw/listen rebinds the live listener.
    function ConnectionPlan({ status, onApplied }) {
      useLang()
      const [applying, setApplying] = React.useState('')
      const [error, setError] = React.useState('')
      // A ref, not `applying`: two selections in the same tick would both read the
      // old state and fire two rebinds, so the guard has to be synchronous.
      const inFlight = React.useRef(false)
      const addresses = (status && status.tailscale && status.tailscale.addresses) || []
      const urls = (status && status.tailscale && status.tailscale.urls) || []
      const plan = planOf(status)
      const tailscaleOff = addresses.length === 0
      // The bind the listener is really on, stated next to the control that chose it:
      // the owner should see "here is what you got", not find it in the card below.
      // `status.lan` moves on apply (onApplied) and on every poll, so both paths show it.
      const lan = (status && status.lan) || {}
      const boundHost = typeof lan.host === 'string' ? lan.host : ''
      const bound = listenerBind(lan)
      const privateHost = boundHost && !isLoopbackHost(boundHost) &&
        !isTailscaleHost(boundHost, addresses)
      const choose = async (target) => {
        if (inFlight.current || !plan || !target) return
        inFlight.current = true
        setApplying(target); setError('')
        try {
          const data = await post('/mgw/listen', { target })
          // The response carries the new bind, so the card below is already right
          // (address, URLs, pin) before the next status poll.
          if (onApplied) onApplied(data)
        } catch (cause) {
          // Nothing local moves on failure: the select falls back to the plan status reports.
          setError(cause.message)
        } finally { inFlight.current = false; setApplying('') }
      }
      return h('div', { className: 'dshdev-card', 'data-testid': 'connection-plan' },
        h('h3', null, tr('planTitle')),
        h('div', { className: 'dshdev-muted', style: { marginBottom: 8 } }, tr('planHelp')),
        h('div', { className: 'dshdev-row' },
          h('select', {
            className: 'dshdev-input', style: { maxWidth: 260 }, 'data-testid': 'plan-select',
            'aria-label': tr('planTitle'), value: applying || plan, disabled: !plan || !!applying,
            onChange: (event) => choose(event.target.value),
          },
            plan ? null : h('option', { value: '' }, tr('planUnknown')),
            PLAN_TARGETS.map((target) => h('option', {
              key: target, value: target, disabled: target === 'tailscale' && tailscaleOff,
            }, tr(`plan.${target}`)))),
          applying ? h('span', { className: 'dshdev-muted', 'data-testid': 'plan-applying' }, tr('planApplying')) : null),
        // Honest consent: what "LAN" means here, and the address it actually produced.
        h('div', { className: 'dshdev-muted', style: { marginTop: 6 }, 'data-testid': 'plan-lan-caveat' }, tr('planLanCaveat')),
        bound ? h('div', { className: 'dshdev-row', style: { marginTop: 6 }, 'data-testid': 'plan-bound' },
          h('span', { className: 'dshdev-muted' }, tr('planBound')),
          h('code', { className: 'dshdev-chip' }, bound)) : null,
        privateHost ? h('div', { className: 'dshdev-muted', 'data-testid': 'plan-private-hint' },
          `${tr('planPrivateHint')} ${boundHost}`) : null,
        // The point of the feature: the Tailscale address the gateway is now on.
        urls.length > 0 ? h('div', { className: 'dshdev-row', style: { marginTop: 8 }, 'data-testid': 'plan-tailscale-urls' },
          h('span', { className: 'dshdev-muted' }, tr('address')),
          urls.map((url) => h('code', { key: String(url), className: 'dshdev-chip' }, String(url)))) : null,
        addresses.length > 0 ? h('div', { className: 'dshdev-muted', 'data-testid': 'plan-tailscale-addresses' },
          addresses.map(String).join(' · ')) : null,
        tailscaleOff ? h('div', { className: 'dshdev-muted', 'data-testid': 'plan-tailscale-unavailable' }, tr('planTailscaleUnavailable')) : null,
        error ? h('div', { className: 'dshdev-err', role: 'alert', 'data-testid': 'plan-error' }, error) : null)
    }

    function ListeningOn({ lan, tailscale }) {
      useLang()
      const info = lan || {}
      const host = typeof info.host === 'string' ? info.host : ''
      const bind = listenerBind(info)
      const up = info.enabled !== false && info.listening === true
      const loopback = up && isLoopbackHost(host)
      const tailscaleAddresses = (tailscale && tailscale.addresses) || []
      // A port the OS may already have handed out, or a bind that failed on a busy
      // one (EADDRINUSE), gets one plain explanation; a quiet port gets no row.
      const port = Number.isInteger(info.port) && info.port > 0 ? info.port : null
      const portRisk = isRiskyListenerPort(port)
      const portBusy = !up && /EADDRINUSE/.test(String(info.error || ''))
      const riskNote = portRisk || portBusy ? h('div', { className: 'dshdev-banner', 'data-testid': 'listener-port-risk' },
        h('div', null,
          h('strong', null, tr(portBusy ? 'portBusyTitle' : 'portRiskTitle')),
          h('div', null, tr(portBusy ? 'portBusyBody' : 'portRiskBody')),
          portRisk ? h('div', null, tr('portRiskSafeBand')) : null,
          h('div', null, tr('portRiskAuto')))) : null
      return h('div', { className: 'dshdev-card', 'data-testid': 'listening-on' },
        h('div', { className: 'dshdev-row' },
          h('h3', { className: 'dshdev-grow', style: { margin: 0 } }, tr('listeningOn')),
          h('span', { className: `dshdev-badge${up ? ' ok' : ' bad'}`, 'data-testid': 'listener-state' }, up ? tr('listenerUp') : tr('listenerDown'))),
        h('div', { className: 'dshdev-row', style: { marginTop: 6 } },
          h('code', { className: 'dshdev-chip', 'data-testid': 'listener-bind' }, bind || tr('listenerUnknown'))),
        info.error ? h('div', { className: 'dshdev-err', role: 'alert', 'data-testid': 'listener-error' }, String(info.error)) : null,
        riskNote,
        info.certSha256 ? h('div', { className: 'dshdev-row', style: { marginTop: 6 } },
          h('span', { className: 'dshdev-muted' }, tr('certPin')),
          h('code', { className: 'dshdev-muted', 'data-testid': 'listener-pin', title: String(info.certSha256) }, shortenHash(info.certSha256))) : null,
        loopback ? h('div', { className: 'dshdev-banner', 'data-testid': 'listener-loopback' },
          h('div', null, h('strong', null, tr('loopbackTitle')), h('div', null, tr('loopbackWarning')))) : null,
        !loopback && up && host ? h('div', { className: 'dshdev-banner info', 'data-testid': 'listener-reachable' },
          h('div', null,
            h('strong', null, tr('reachableTitle')),
            h('div', null, `${tr('reachableNote')} ${bind || host}`),
            tailscaleAddresses.includes(host) ? h('div', { 'data-testid': 'listener-tailscale' }, tr('reachableTailscale')) : null)) : null)
    }

    function AllowTab() {
      useLang()
      const [status, setStatus] = React.useState(null)
      const [devices, setDevices] = React.useState([])
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [pairing, setPairing] = React.useState(null)
      const [otpOffer, setOtpOffer] = React.useState(null)
      const [editing, setEditing] = React.useState(null) // { device, scopes }
      const mounted = React.useRef(true)

      const refresh = React.useCallback(async () => {
        try {
          const [s, d] = await Promise.all([request('/mgw/status'), request('/mgw/devices')])
          if (!mounted.current) return
          setStatus(s)
          setDevices(d.devices || [])
        } catch (cause) { if (mounted.current) setError(cause.message) }
      }, [])
      React.useEffect(() => {
        mounted.current = true
        refresh()
        const timer = window.setInterval(refresh, 3000)
        return () => { mounted.current = false; window.clearInterval(timer) }
      }, [refresh])

      const enabled = !!(status && status.remoteControl && status.remoteControl.enabled)
      const accepting = !!(status && status.remoteControl && status.remoteControl.accepting)
      const on = enabled && accepting

      const toggle = async () => {
        if (busy) return
        setBusy(true); setError('')
        try {
          if (!on) {
            // Same calls as the gateway panel: owner switch, then run the gateway,
            // then pick the LAN route (the only one this page supports).
            await post('/mgw/remote-control', { enabled: true })
            await post('/mgw/gateway', { mode: 'persistent' })
            await post('/mgw/connection', { route: 'lan' })
          } else {
            await post('/mgw/remote-control', { enabled: false })
            setPairing(null)
          }
          await refresh()
        } catch (cause) { setError(cause.message) } finally { setBusy(false) }
      }

      // Window 1: an 8-digit single-use code (spec 008 P1b).
      const generateOtp = async () => {
        if (busy) return
        setBusy(true); setError('')
        try {
          setPairing(null)
          // The offer asks for every desktop scope so the Host user can choose at
          // Approve (which defaults to Standard); nothing is granted until then.
          setOtpOffer(await post('/mgw/pair', { mode: 'otp', kind: 'desktop', scopes: [...ALL_SCOPES] }))
        } catch (cause) { setError(cause.message) } finally { setBusy(false) }
      }

      // Edit permissions still re-pairs through a long pairing string.
      const generate = async (scopes) => {
        if (busy) return
        setBusy(true); setError('')
        try {
          const body = { kind: 'desktop', ...(scopes ? { scopes } : {}) }
          setPairing(await post('/mgw/pair', body))
          setEditing(null)
        } catch (cause) { setError(cause.message) } finally { setBusy(false) }
      }

      const revoke = async (device) => {
        if (!window.confirm(tr('removeConfirm'))) return
        try { await post(`/mgw/devices/${encodeURIComponent(device.id)}/revoke`); await refresh() } catch (cause) { setError(cause.message) }
      }

      // /mgw/listen answers with the bind it applied, so the card below is correct
      // at once instead of waiting up to 3 s for the next status poll.
      const applyPlan = (next) => setStatus((prev) => {
        const merged = { ...(prev || {}) }
        if (next && next.lan) merged.lan = next.lan
        if (next && next.tailscale) merged.tailscale = next.tailscale
        return merged
      })

      const addresses = (status && status.lan && status.lan.listening ? status.lan.urls || [] : [])
        .map((url) => { try { return new URL(url).host } catch { return '' } }).filter(Boolean)

      return h('div', null,
        h('div', { className: 'dshdev-card' },
          h('div', { className: 'dshdev-row' },
            h('div', { className: 'dshdev-grow' },
              h('h3', null, tr('allow')),
              h('div', { className: 'dshdev-muted' }, tr('allowHelp'))),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': tr('allow'),
              className: 'dshdev-switch', disabled: busy || !status, onClick: toggle,
            })),
          h('div', { className: 'dshdev-row', style: { marginTop: 10 } },
            h('label', { className: 'dshdev-row' },
              h('input', { type: 'checkbox', checked: true, disabled: true, readOnly: true }), tr('lan')),
            h('label', { className: 'dshdev-row', title: tr('internetLater') },
              h('input', { type: 'checkbox', checked: false, disabled: true, readOnly: true }), tr('internet'),
              h('span', { className: 'dshdev-muted' }, `(${tr('internetLater')})`)))),
        error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
        h('div', { className: 'dshdev-card' },
          h('div', { className: 'dshdev-row' },
            h('h3', { className: 'dshdev-grow' }, tr('pairingCode')),
            h('button', { type: 'button', className: 'dshdev-btn primary', disabled: busy || !on, onClick: generateOtp }, tr('generate'))),
          !on ? h('div', { className: 'dshdev-muted' }, tr('enableFirst')) : null),
        otpOffer ? h(OtpDialog, { offer: otpOffer, addresses, onClose: () => setOtpOffer(null) }) : null,
        h(PendingRequests, { active: on }),
        pairing && !editing ? h(PairingBox, { pairing, onClose: () => setPairing(null) }) : null,
        h('div', { className: 'dshdev-card' },
          h('h3', null, tr('address')),
          addresses.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('noAddress'))
            : h('div', { className: 'dshdev-row' }, addresses.map((address) =>
              h('span', { key: address, className: 'dshdev-chip' }, address, h(CopyButton, { text: address }))))),
        h('div', { className: 'dshdev-card' },
          h('h3', null, tr('authorized')),
          devices.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('noAuthorized'))
            : h('div', { className: 'dshdev-list' }, devices.map((device) => h('div', { key: device.id },
              h('div', { className: 'dshdev-grow' },
                h('div', { className: 'dshdev-row' },
                  h('strong', null, device.displayName || device.name),
                  h('span', { className: 'dshdev-badge' }, device.kind || 'mobile'),
                  device.online ? h('span', { className: 'dshdev-badge ok' }, tr('connectedHere')) : null),
                h('div', { className: 'dshdev-muted' }, `${tr('scopes')}: ${(device.scopes || []).map((scope) => tr(`scope.${scope}`)).join(', ') || '—'}`),
                h('div', { className: 'dshdev-muted' }, `${tr('lastUsed')}: ${device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : tr('never')}`)),
              h('button', { type: 'button', className: 'dshdev-btn', disabled: !on, onClick: () => { setPairing(null); setEditing({ device, scopes: [...(device.scopes || [])] }) } }, tr('edit')),
              h('button', { type: 'button', className: 'dshdev-btn danger', onClick: () => revoke(device) }, tr('remove')))))),
        editing ? h('div', { className: 'dshdev-card', 'data-testid': 'edit-permissions' },
          h('h3', null, `${tr('edit')} — ${editing.device.displayName || editing.device.name}`),
          h('div', { className: 'dshdev-muted', style: { marginBottom: 8 } }, tr('editHelp')),
          h(ScopePicker, { scopes: editing.scopes, onChange: (scopes) => setEditing({ ...editing, scopes }) }),
          h('div', { className: 'dshdev-row', style: { marginTop: 10 } },
            h('button', { type: 'button', className: 'dshdev-btn primary', disabled: busy, onClick: () => generate(editing.scopes) }, tr('editSave')),
            h('button', { type: 'button', className: 'dshdev-btn', onClick: () => setEditing(null) }, tr('cancel')))) : null,
        pairing && editing ? h(PairingBox, { pairing }) : null,
        h(ConnectionPlan, { status, onApplied: applyPlan }),
        h(ListeningOn, { lan: status && status.lan, tailscale: status && status.tailscale }),
        h(AdvancedLimits, { limits: status && status.remoteBridgeLimits }))
    }

    // --------------------------------------------------- tab 2: connect
    // "Add device" (Qoder-style): LAN | Internet(disabled), Address, 8-digit pairing
    // code, Display name; the pairing string is an "Advanced" link. Submitting
    // starts a server-side pairing session that waits for the Host's approval; the
    // dialog polls it, shows the verification code, and can cancel.
    function AddDeviceDialog({ onClose, onAdded }) {
      useLang()
      const [address, setAddress] = React.useState('')
      const [code, setCode] = React.useState('')
      const [pairingString, setPairingString] = React.useState('')
      const [advanced, setAdvanced] = React.useState(false)
      const [name, setName] = React.useState('')
      const [session, setSession] = React.useState(null) // pairing view from /devices/pairings
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const mounted = React.useRef(true)
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

      const active = session && (session.state === 'connecting' || session.state === 'pending')
      React.useEffect(() => {
        if (!active) return undefined
        const timer = window.setInterval(async () => {
          try {
            const data = await request(`/devices/pairings/${encodeURIComponent(session.id)}`)
            if (!mounted.current) return
            setSession(data.pairing)
            if (data.pairing.state === 'approved') onAdded()
          } catch (cause) { if (mounted.current) setError(cause.message) }
        }, 1000)
        return () => window.clearInterval(timer)
      }, [active, session && session.id])

      const submit = async (event) => {
        event.preventDefault()
        if (busy || active) return
        setBusy(true); setError('')
        try {
          const body = { address: address.trim(), ...(name.trim() ? { name: name.trim() } : {}),
            ...(advanced ? { pairingString: pairingString.trim() } : { otp: code.replace(/\D/g, '') }) }
          setSession((await post('/devices/pairings', body)).pairing)
        } catch (cause) { setError(cause.message) } finally { setBusy(false) }
      }
      const cancel = async () => {
        if (active) { try { await request(`/devices/pairings/${encodeURIComponent(session.id)}`, { method: 'DELETE' }) } catch { /* it ends on its own */ } }
        onClose()
      }
      const ready = address.trim() && (advanced ? pairingString.trim() : code.replace(/\D/g, '').length === 8)

      if (session && session.state === 'approved') {
        return h(Dialog, { title: tr('addTitle'), onClose: cancel },
          h('div', { className: 'dshdev-badge ok' }, tr('pairApproved')),
          h('div', { className: 'dshdev-row', style: { marginTop: 12 } }, h('button', { type: 'button', className: 'dshdev-btn primary', onClick: onClose }, tr('otpClose'))))
      }
      if (active) {
        return h(Dialog, { title: tr('addTitle'), onClose: cancel },
          h('h3', null, tr('waiting')),
          session.verificationCode
            ? h('div', null, h('div', { className: 'dshdev-muted' }, tr('waitingCode')), h('div', { className: 'dshdev-vcode', 'data-testid': 'waiting-code' }, session.verificationCode))
            : h('div', { className: 'dshdev-muted' }, tr('working')),
          h('div', { className: 'dshdev-muted', style: { margin: '8px 0' } }, tr('waitingHelp')),
          h('div', { className: 'dshdev-row' }, h('button', { type: 'button', className: 'dshdev-btn', onClick: cancel }, tr('cancelWait'))))
      }
      return h(Dialog, { title: tr('addTitle'), onClose },
        h('form', { onSubmit: submit },
          h('div', { style: { display: 'grid', gap: 10 } },
            h('div', { className: 'dshdev-seg', role: 'group' },
              h('button', { type: 'button', 'aria-pressed': true }, tr('addLan')),
              h('button', { type: 'button', disabled: true, title: tr('internetLater') }, tr('addInternetLater'))),
            h('label', null, h('div', { className: 'dshdev-muted' }, tr('addAddress')),
              h('input', { className: 'dshdev-input', value: address, placeholder: '192.168.1.9:41234', onChange: (e) => setAddress(e.target.value), 'aria-label': tr('addAddress') })),
            advanced
              ? h('label', null, h('div', { className: 'dshdev-muted' }, tr('pairingLabel')),
                h('textarea', { className: 'dshdev-input', rows: 3, value: pairingString, spellCheck: false, onChange: (e) => setPairingString(e.target.value), 'aria-label': tr('pairingLabel') }))
              : h('label', null, h('div', { className: 'dshdev-muted' }, `${tr('addCode')} — ${tr('addCodeHint')}`),
                h('input', { className: 'dshdev-input', value: code, inputMode: 'numeric', autoComplete: 'off', placeholder: '1234 5678', maxLength: 9,
                  onChange: (e) => setCode(e.target.value), 'aria-label': tr('addCode') })),
            h('label', null, h('div', { className: 'dshdev-muted' }, tr('addName')),
              h('input', { className: 'dshdev-input', value: name, onChange: (e) => setName(e.target.value), 'aria-label': tr('addName') })),
            h('button', { type: 'button', className: 'dshdev-btn', style: { justifySelf: 'start', border: 0, padding: 0, textDecoration: 'underline' },
              onClick: () => setAdvanced(!advanced) }, advanced ? tr('advancedBack') : tr('advanced')),
            h('div', { className: 'dshdev-muted' }, tr('addNote')),
            error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
            h('div', { className: 'dshdev-row', style: { justifyContent: 'flex-end' } },
              h('button', { type: 'button', className: 'dshdev-btn', onClick: onClose }, tr('cancel')),
              h('button', { type: 'submit', className: 'dshdev-btn primary', disabled: busy || !ready }, busy ? tr('working') : tr('addSubmit'))))))
    }

    function AddDeviceForm({ onAdded }) {
      useLang()
      const [open, setOpen] = React.useState(false)
      return h('div', { className: 'dshdev-card' },
        h('div', { className: 'dshdev-row' },
          h('h3', { className: 'dshdev-grow', style: { margin: 0 } }, tr('addDevice')),
          h('button', { type: 'button', className: 'dshdev-btn primary', onClick: () => setOpen(true) }, tr('addDevice'))),
        open ? h(AddDeviceDialog, { onClose: () => setOpen(false), onAdded }) : null)
    }
    function statusBadge(status) {
      const cls = status === 'online' ? 'ok' : (status === 'revoked' || status === 'error') ? 'bad' : ''
      return h('span', { className: `dshdev-badge ${cls}` }, tr(`status.${status}`))
    }

    function RemoteDetail({ remote, onBack, onChanged }) {
      useLang()
      const [sessions, setSessions] = React.useState(null)
      const [approvals, setApprovals] = React.useState(remote.approvals || [])
      const [selected, setSelected] = React.useState('')
      const [history, setHistory] = React.useState(null)
      const [text, setText] = React.useState('')
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const base = `/devices/remotes/${encodeURIComponent(remote.id)}`
      const mounted = React.useRef(true)

      const load = React.useCallback(async () => {
        try {
          const data = await request(`${base}/sessions`)
          if (!mounted.current) return
          setSessions(data.sessions || []); setApprovals(data.approvals || []); setError('')
        } catch (cause) { if (mounted.current) setError(cause.message) }
      }, [base])
      React.useEffect(() => {
        mounted.current = true
        load()
        const timer = window.setInterval(load, 4000)
        return () => { mounted.current = false; window.clearInterval(timer) }
      }, [load])

      const openSession = async (sessionId) => {
        setSelected(sessionId); setHistory(null); setNote('')
        // A subagent child is readable only with its durable parent address (DSH
        // refuses a plain session address with `session/agent-busy`). The row this
        // view already listed names the parent, so the request carries it instead of
        // relying on the server-side fallback.
        const row = (sessions || []).find((entry) => (entry.sessionId || entry.id) === sessionId)
        const parent = row && row.origin === 'subagent' && typeof row.parentSessionId === 'string' ? row.parentSessionId : ''
        const target = `${base}/history?sessionId=${encodeURIComponent(sessionId)}` +
          (parent ? `&parentSessionId=${encodeURIComponent(parent)}&subagentMode=unknown` : '')
        try { setHistory((await request(target)).history) } catch (cause) { setError(cause.message) }
      }
      const send = async () => {
        if (!selected || !text.trim()) return
        try {
          await post(`${base}/prompt`, { sessionId: selected, text })
          setText(''); setNote(tr('sent'))
          openSession(selected)
        } catch (cause) { setError(cause.message) }
      }
      const decide = async (approval, outcome) => {
        try {
          // Echo the hash the card showed; the server binds the decision to it.
          await post(`${base}/approval`, { rpcId: approval.rpcId, sessionId: approval.sessionId, approvalId: approval.approvalId, argsHash: approval.argsHash, outcome })
          await load()
        } catch (cause) { setError(cause.message); load() }
      }
      const sessionTitle = (row) => (row.projections && row.projections.values && row.projections.values.title) || row.title || row.sessionId || row.id
      const rows = (history && (history.items || history.records || history.messages)) || []

      return h('div', null,
        h('div', { className: 'dshdev-row', style: { marginBottom: 10 } },
          h('button', { type: 'button', className: 'dshdev-btn', onClick: onBack }, tr('back')),
          h('h3', { className: 'dshdev-grow', style: { margin: 0 } }, remote.name),
          statusBadge(remote.status),
          h('button', { type: 'button', className: 'dshdev-btn', onClick: load }, tr('refresh'))),
        error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
        h('div', { className: 'dshdev-card' },
          h('h3', null, tr('approvals')),
          approvals.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('noApprovals'))
            : h('div', { className: 'dshdev-list' }, approvals.map((approval) => h('div', { key: approval.rpcId },
              h('div', { className: 'dshdev-grow' },
                h('strong', null, approval.toolName),
                approval.reason ? h('div', { className: 'dshdev-muted' }, approval.reason) : null,
                approval.argsPreview ? h('code', { className: 'dshdev-code' }, approval.argsPreview) : null,
                typeof approval.argsHash !== 'string' ? h('div', { className: 'dshdev-muted' }, tr('desktopOnly')) : null),
              typeof approval.argsHash === 'string' ? [
                h('button', { key: 'a', type: 'button', className: 'dshdev-btn primary', onClick: () => decide(approval, 'allowed-once') }, tr('allowOnce')),
                h('button', { key: 'r', type: 'button', className: 'dshdev-btn danger', onClick: () => decide(approval, 'rejected') }, tr('reject')),
              ] : null)))),
        h('div', { className: 'dshdev-card' },
          h('h3', null, tr('sessions')),
          sessions === null ? h('div', { className: 'dshdev-muted' }, tr('working'))
            : sessions.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('noSessions'))
              : h('div', { className: 'dshdev-list' }, sessions.map((row) => {
                const sessionId = row.sessionId || row.id
                return h('div', { key: sessionId },
                  h('div', { className: 'dshdev-grow' }, sessionTitle(row), row.running ? h('span', { className: 'dshdev-badge ok', style: { marginLeft: 8 } }, '●') : null),
                  h('button', { type: 'button', className: 'dshdev-btn', 'aria-pressed': selected === sessionId, onClick: () => openSession(sessionId) }, tr('open')))
              }))),
        selected ? h('div', { className: 'dshdev-card' },
          h('h3', null, tr('history')),
          history === null ? h('div', { className: 'dshdev-muted' }, tr('working'))
            : rows.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('noHistory'))
              : rows.map((row, index) => h('div', { key: row.seq ?? index, className: `dshdev-msg ${row.role === 'user' ? 'user' : ''}` },
                typeof row.text === 'string' ? row.text : (typeof row.content === 'string' ? row.content : JSON.stringify(row)).slice(0, 2000))),
          h('h3', { style: { marginTop: 12 } }, tr('prompt')),
          h('textarea', { className: 'dshdev-input', rows: 3, value: text, onChange: (e) => setText(e.target.value), 'aria-label': tr('prompt') }),
          h('div', { className: 'dshdev-row', style: { marginTop: 8 } },
            h('button', { type: 'button', className: 'dshdev-btn primary', disabled: !text.trim(), onClick: send }, tr('send')),
            note ? h('span', { className: 'dshdev-muted' }, note) : null)) : null)
    }

    const scopesOfGrant = (remote) => (remote && remote.device && Array.isArray(remote.device.scopes) ? remote.device.scopes : null)
    /**
     * The grant a remote Host made does not include `harness:remote`, so the merged
     * session/workspace lists carry Local rows only — the feature is dead while every
     * indicator stays green (spec 008, measured end to end). Re-pairing is the only
     * fix: the gateway has no scope-update route.
     * A gateway older than scopes sends no list at all; then nothing is claimed.
     */
    const lacksRemoteScope = (remote) => {
      const scopes = scopesOfGrant(remote)
      return scopes !== null && !scopes.includes('harness:remote')
    }

    function ConnectTab() {
      useLang()
      const [remotes, setRemotes] = React.useState([])
      const [openId, setOpenId] = React.useState('')
      const [error, setError] = React.useState('')
      const mounted = React.useRef(true)
      const refresh = React.useCallback(async () => {
        try { const data = await request('/devices/remotes'); if (mounted.current) setRemotes(data.remotes || []) } catch (cause) { if (mounted.current) setError(cause.message) }
      }, [])
      React.useEffect(() => {
        mounted.current = true
        refresh()
        const timer = window.setInterval(refresh, 4000)
        return () => { mounted.current = false; window.clearInterval(timer) }
      }, [refresh])
      const opened = remotes.find((remote) => remote.id === openId)
      if (opened) return h(RemoteDetail, { remote: opened, onBack: () => setOpenId(''), onChanged: refresh })
      const remove = async (remote) => {
        try { await request(`/devices/remotes/${encodeURIComponent(remote.id)}`, { method: 'DELETE' }); await refresh() } catch (cause) { setError(cause.message) }
      }
      return h('div', null,
        h(AddDeviceForm, { onAdded: refresh }),
        error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
        h(RemoteGroupingStatus),
        h('div', { className: 'dshdev-card' },
          h('h3', null, tr('remotes')),
          remotes.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('noRemotes'))
            : h('div', { className: 'dshdev-list' }, remotes.map((remote) => h('div', { key: remote.id },
              h('div', { className: 'dshdev-grow' },
                h('div', { className: 'dshdev-row' }, h('strong', null, remote.name), statusBadge(remote.status)),
                h('div', { className: 'dshdev-muted' }, remote.address),
                lacksRemoteScope(remote)
                  ? h('div', { className: 'dshdev-warn', 'data-testid': 'missing-remote-scope', role: 'status' }, tr('missingRemoteScope'))
                  : null,
                remote.hostError
                  ? h('div', { className: 'dshdev-muted', 'data-testid': 'host-refused' },
                    `${tr('hostRefused')} — ${remote.hostError.code}${remote.hostError.scope ? ` (${remote.hostError.scope})` : ''}`)
                  : null,
                remote.approvals && remote.approvals.length ? h('div', { className: 'dshdev-badge bad' }, `${tr('approvals')}: ${remote.approvals.length}`) : null),
              h('button', { type: 'button', className: 'dshdev-btn', disabled: remote.status === 'revoked', onClick: () => setOpenId(remote.id) }, tr('open')),
              h('button', { type: 'button', className: 'dshdev-btn danger', onClick: () => remove(remote) }, tr('removeRemote')))))))
    }

    // --------------------------------------- spec 008 P2b: native remote sessions
    // Plain-script mirror of lib/host-router.mjs's tag. A remote id is
    // `h:<hostId>:<id>` and <hostId> is the remote record id, so ONE
    // GET /devices/remotes answers who the host is, whether it is online and which
    // scopes the device holds — the same facts the sidebar, the chip and the
    // banners need, so they cannot disagree with each other.
    const HOST_TAG = /^h:([^:]+):(.+)$/
    function hostTagOf(value) {
      const match = typeof value === 'string' ? HOST_TAG.exec(value) : null
      return match ? { hostId: match[1], rawId: match[2] } : null
    }
    const stamp = (value) => {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 16).replace('T', ' ')
    }
    const ANY = (state) => state
    const titleOf = (row, fallback) => (row && (row.displayTitle || row.title)) || fallback || ''
    /**
     * DSH's own sidebar nests a subagent session under its parent (`flattenLineage`):
     * a row with `origin:'subagent'` whose `parentSessionId` is in the same list is
     * rendered under that parent with a depth; an orphan (parent absent) or a row
     * whose lineage loops stays a ROOT row — never dropped. Same rule inside a remote
     * host group, where the list is the workspace's rows and a remote parent arrives
     * tagged (`h:<hostId>:<id>`) by the router.
     */
    const nestByParent = (rows) => {
      const byId = new Map(rows.map((row) => [row.id, row]))
      const parentOf = (row) => {
        const summary = row.summary || {}
        if (summary.origin !== 'subagent' || typeof summary.parentSessionId !== 'string') return undefined
        return byId.get(summary.parentSessionId)
      }
      // 0 for a root or a cycle member; otherwise how many parents this list holds.
      const depthOf = (row) => {
        const seen = new Set([row.id])
        let depth = 0
        for (let current = parentOf(row); current; current = parentOf(current)) {
          if (seen.has(current.id)) return 0
          seen.add(current.id)
          depth += 1
        }
        return depth
      }
      const depths = new Map(rows.map((row) => [row.id, depthOf(row)]))
      const ordered = []
      const emitted = new Set()
      const emit = (row) => {
        if (emitted.has(row.id)) return
        emitted.add(row.id)
        ordered.push({ ...row, depth: depths.get(row.id) })
        for (const child of rows) if (depths.get(child.id) > 0 && parentOf(child) === row) emit(child)
      }
      for (const row of rows) if (depths.get(row.id) === 0) emit(row)
      for (const row of rows) emit(row)
      return ordered
    }

    const EMPTY_HOSTS = { hosts: [], remotes: [], routing: null, error: '', loaded: false }
    function createHostsStore() {
      let snapshot = EMPTY_HOSTS
      const listeners = new Set()
      const publish = (next) => {
        snapshot = next
        for (const listener of [...listeners]) {
          // One surface failing must not take the others down with it.
          try { listener() } catch { /* keep publishing */ }
        }
      }
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        async refresh() {
          try {
            const data = await request('/devices/remotes')
            const routing = data.routing || { remote: false, reason: 'not-reported', hosts: [] }
            publish({
              remotes: (data.remotes || []).map((remote) => ({
                id: remote.id, name: remote.name, address: remote.address, status: remote.status,
                createdAt: remote.createdAt ?? null,
                kind: (remote.device && remote.device.kind) || null,
                scopes: remote.device && Array.isArray(remote.device.scopes) ? remote.device.scopes : [],
              })),
              // index.mjs answers with exactly the CONNECTED hosts, so a host here is
              // online by construction; a tagged session whose host is absent is the
              // offline case the banner is for.
              hosts: (Array.isArray(routing.hosts) ? routing.hosts : []).map((host) => ({
                hostId: String(host.hostId), hostName: String(host.hostName ?? host.hostId), online: host.online !== false,
                // The host-router's last refusal for this host (`status().hosts[].error`);
                // it only reports one when there is something to say, so a healthy host
                // stays `null`.
                error: host.error ?? null,
              })),
              routing,
              error: '',
              loaded: true,
            })
          } catch (cause) {
            publish({ ...snapshot, error: cause.message, loaded: true })
          }
        },
      }
    }
    const hostsStore = createHostsStore()
    const useHosts = (store) => React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

    // Why the grouped sidebar is (not) installed. The Devices page shows this line:
    // a replacement that quietly failed to install must be visible, not guessed at.
    const remoteUI = (() => {
      let snapshot = { grouped: false, reason: 'not installed', hosts: 0 }
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        set(patch) {
          snapshot = { ...snapshot, ...patch }
          for (const listener of [...listeners]) {
            try { listener() } catch { /* a status surface must not throw */ }
          }
        },
      }
    })()
    const useRemoteUI = () => React.useSyncExternalStore(remoteUI.subscribe, remoteUI.getSnapshot, remoteUI.getSnapshot)

    // What a click may call. Empty until the shell hands the services over
    // (installRemoteSurfaces); every affordance disables itself instead of
    // pretending, and the two pin methods are used only when the service has them
    // (the client service catalog documents open/start/archive/unarchive, not pin).
    const nav = {
      openSession: null, startSession: null, archiveSession: null, unarchiveSession: null,
      pinSession: null, unpinSession: null, openTerminal: null,
    }

    // The host-grouped browser: "Local workspaces" first, then one group per
    // connected host, each with that host's workspaces and their nested sessions.
    // It REPLACES the single `sidebar.workspaces` slot (rc.1 has no group header
    // slot), which is why installRemoteSurfaces also removes it again on any error.
    function GroupedWorkspaces(props) {
      useLang()
      const hosts = useHosts(hostsStore)
      // The standard hooks arrive as props from the shell's root bindings; without
      // them there is no merged list to group. Reporting beats an empty sidebar.
      const ready = ['useWorkspaces', 'useSessions', 'useSessionStatus'].every((name) => typeof props[name] === 'function')
      if (!ready) return h('div', { className: 'dshdev-side dshdev-muted', 'data-testid': 'grouped-sidebar-off' }, tr('sidebarOff'))
      if (props.wide === false) return h(RailHosts, { hosts: hosts.hosts })
      return h(GroupedTree, { ...props, hosts })
    }

    // Rail (collapsed) mode: only who is connected, never the full list.
    function RailHosts({ hosts }) {
      useLang()
      return h('div', { className: 'dshdev-side', 'data-testid': 'grouped-sidebar-rail' }, hosts.map((host) =>
        h('div', { key: host.hostId, className: 'dshdev-side-head', title: host.hostName },
          h('span', { className: `dshdev-dot ${host.online ? 'ok' : 'off'}` }),
          h('strong', null, host.hostName.slice(0, 2)))))
    }

    function GroupedTree(props) {
      useLang()
      // Unconditional hook calls: the ready check happened in GroupedWorkspaces.
      const workspaces = props.useWorkspaces(ANY) || {}
      const sessions = props.useSessions(ANY) || {}
      const statuses = props.useSessionStatus(ANY)
      const [query, setQuery] = React.useState('')
      const byId = sessions.byId || {}
      const items = Array.isArray(workspaces.items) ? workspaces.items : []
      const pinned = new Set(workspaces.pinnedSessionIds || [])
      const archived = new Set(workspaces.archivedSessionIds || [])
      const statusOf = (sessionId) => {
        // The shell hands a Map over; a realm boundary (or a test) can make
        // `instanceof` lie, so the shape is what is trusted.
        if (statuses && typeof statuses.get === 'function') return statuses.get(sessionId) || {}
        if (statuses && typeof statuses === 'object') return statuses[sessionId] || {}
        return {}
      }
      const call = (name, ...args) => {
        const fn = typeof props[name] === 'function' ? props[name] : nav[name]
        if (typeof fn !== 'function') return
        try {
          const result = fn(...args)
          if (result && typeof result.catch === 'function') result.catch(() => { /* the shell reports its own refusal */ })
        } catch (cause) {
          // A broken replacement must fall back to the stock browser, not blank.
          if (typeof props.onError === 'function') props.onError(cause && cause.message ? cause.message : 'the grouped sidebar failed')
        }
      }
      const groups = [
        { key: 'local', hostId: null, name: tr('groupLocal'), online: true, error: null },
        ...props.hosts.hosts.map((host) => ({ key: `h:${host.hostId}`, hostId: host.hostId, name: host.hostName, online: host.online !== false, error: host.error ?? null })),
        // A paired host with no live link is absent from routing, and merged
        // `workspace/follow` delivers nothing for it — so its group was the one that
        // claimed "lists no workspace" while the host simply was not connected (spec
        // 008 P2b, measured on the owner's screen: the host's own `/mgw/status` said
        // `devices: 0`). Keep the group and let it say it is offline. A revoked
        // pairing never reconnects, so it stays a Devices-page matter.
        ...(props.hosts.remotes || [])
          .filter((remote) => remote.status !== 'revoked' && !props.hosts.hosts.some((host) => host.hostId === remote.id))
          .map((remote) => ({ key: `h:${remote.id}`, hostId: remote.id, name: remote.name || remote.id, online: remote.status === 'online', error: null })),
      ]
      const workspacesOf = (key) => items.filter((item) => {
        const tag = hostTagOf(item.workspaceId)
        return (tag ? `h:${tag.hostId}` : 'local') === key
      })
      // `workspace.sessionIds` is renamed with the payload, so a remote workspace
      // already lists its sessions by tagged id and a summary lookup is enough.
      const sessionsOf = (workspace) => (Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [])
        .map((id) => ({ id, summary: byId[id] || null }))
        .filter((row) => row.summary)
      const needle = query.trim().toLowerCase()
      const hit = (text) => String(text || '').toLowerCase().includes(needle)
      const entriesOf = (group) => workspacesOf(group.key).map((workspace) => ({ workspace, rows: sessionsOf(workspace) }))
      // Search filters ACROSS groups: a host name match keeps the whole group, a
      // session match keeps just those rows, and a group with no match disappears.
      const filtered = (group) => {
        const entries = entriesOf(group)
        if (!needle) return entries
        if (hit(group.name)) return entries
        return entries
          .map((entry) => ({ ...entry, rows: entry.rows.filter((row) => hit(titleOf(row.summary, row.id))) }))
          .filter((entry) => entry.rows.length > 0)
      }
      const newSession = (group, workspaceId) => {
        const target = workspaceId || (entriesOf(group)[0] || {}).workspace?.workspaceId
        // A remote group has no workspace to create into until one is listed.
        if (!target && group.hostId) return
        call('startSession', target)
      }
      // An empty group used to say "lists no workspace" whatever the cause. Three
      // different truths hide behind that: the host is connected and really has none,
      // the host has no live link (so the merged lists deliver nothing), or the host
      // refused the call. Name the one that applies, in the quiet style of the
      // per-row refusal line.
      const emptyNote = (group) => {
        if (!group.online) {
          return h('div', { className: 'dshdev-side-ws', 'data-testid': 'group-host-offline', role: 'status' }, tr('groupHostOffline'))
        }
        if (group.error) {
          return h('div', { className: 'dshdev-side-ws', 'data-testid': 'group-host-refused', role: 'status' },
            `${tr('groupHostRefused')} — ${group.error.code}${group.error.scope ? ` (${group.error.scope})` : ''}`)
        }
        return h('div', { className: 'dshdev-side-ws' }, tr('groupNoWorkspaces'))
      }
      const sessionRow = (id, summary, depth = 0) => {
        const status = statusOf(id)
        const isPinned = pinned.has(id)
        const isArchived = archived.has(id)
        // No per-row child seats here (sidebar.session.row.leading/.trailing/.hover,
        // sidebar.workspaces.session.row.action). A row cannot render them: the shell
        // hands `renderSlot` only to an entry that declares those children itself, and
        // SlotCore.register refuses a child key another live entry declares — the stock
        // browser declares all four and stays live under this shadow at priority 0.
        // Measured cost of trying anyway: the registration throws and the grouped
        // sidebar falls back entirely. Leave them out rather than re-add a broken call.
        return h('div', { key: id, className: 'dshdev-side-session', 'data-testid': 'session-row', 'data-depth': depth,
          style: depth > 0 ? { paddingLeft: 12 * depth } : undefined },
          h('button', { type: 'button', className: 'dshdev-side-title', title: titleOf(summary, id), 'data-testid': 'session-open',
            onClick: () => call('openSession', id) }, titleOf(summary, id)),
          status.completionUnread === true || summary.unread === true
            ? h('span', { className: 'dshdev-dot ok', title: tr('unread'), 'data-testid': 'unread-dot' }) : null,
          isPinned ? h('span', { className: 'dshdev-side-meta', title: tr('pinned'), 'data-testid': 'pinned-mark' }, '★') : null,
          isArchived ? h('span', { className: 'dshdev-side-meta', 'data-testid': 'archived-mark' }, tr('archived')) : null,
          h('span', { className: 'dshdev-side-meta', title: tr('lastActivity'), 'data-testid': 'last-activity' }, stamp(summary.updatedAt)),
          h('button', { type: 'button', className: 'dshdev-side-action', 'data-testid': 'pin-toggle',
            title: isPinned ? tr('unpinSession') : tr('pinSession'), 'aria-pressed': isPinned,
            onClick: () => call(isPinned ? 'unpinSession' : 'pinSession', id) }, isPinned ? '★' : '☆'),
          h('button', { type: 'button', className: 'dshdev-side-action', 'data-testid': 'archive-toggle',
            title: isArchived ? tr('unarchiveSession') : tr('archiveSession'),
            onClick: () => call(isArchived ? 'unarchiveSession' : 'archiveSession', id) }, isArchived ? '↺' : '⌫'))
      }
      return h('div', { className: 'dshdev-side', 'data-testid': 'grouped-sidebar' },
        h('input', { className: 'dshdev-side-search', type: 'search', value: query, placeholder: tr('groupSearch'),
          'aria-label': tr('groupSearch'), 'data-testid': 'group-search', onChange: (event) => setQuery(event.target.value) }),
        groups.map((group) => {
          const entries = filtered(group)
          if (needle && entries.length === 0) return null
          return h('div', { key: group.key, className: 'dshdev-side-group', 'data-testid': 'host-group', 'data-host': group.hostId || 'local' },
            h('div', { className: 'dshdev-side-head' },
              group.hostId ? h('span', { className: `dshdev-dot ${group.online ? 'ok' : 'off'}`, 'data-testid': 'host-dot' }) : null,
              h('strong', { className: 'dshdev-grow' }, group.name),
              h('button', { type: 'button', className: 'dshdev-side-new', 'data-testid': 'group-new-session',
                title: group.hostId ? tr('newSessionIn') : tr('newSession'), 'aria-label': `${tr('newSession')}: ${group.name}`,
                onClick: () => newSession(group) }, '+')),
            entries.length === 0 ? emptyNote(group) : null,
            entries.map(({ workspace, rows }) => h('div', { key: workspace.workspaceId, 'data-testid': 'workspace-row' },
              h('div', { className: 'dshdev-side-ws' },
                h('span', null, titleOf(workspace, workspace.workspaceId)),
                h('button', { type: 'button', className: 'dshdev-side-new', 'data-testid': 'workspace-new-session',
                  title: tr('newSession'), 'aria-label': `${tr('newSession')} ${titleOf(workspace, '')}`,
                  onClick: () => newSession(group, workspace.workspaceId) }, '+')),
              nestByParent(rows).map(({ id, summary, depth }) => sessionRow(id, summary, depth)))))
        }),
        needle && groups.every((group) => filtered(group).length === 0)
          ? h('div', { className: 'dshdev-side-ws', 'data-testid': 'group-no-matches' }, tr('groupNoMatches')) : null)
    }

    // Composer chip: only a TAGGED session has a host to name. Clicking it toggles a
    // popover; there is no public service to open Settings on rc.1, so the popover
    // is where the host actions live and its last line says where the full page is.
    function HostChip(props) {
      useLang()
      const hosts = useHosts(hostsStore)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const tag = hostTagOf(props.sessionId)
      if (!tag) return null
      const id = tag.hostId
      const host = hosts.hosts.find((entry) => entry.hostId === id)
      const remote = hosts.remotes.find((entry) => entry.id === id)
      const online = !!(host && host.online !== false)
      const name = (host && host.hostName) || (remote && remote.name) || id
      const scopes = (remote && remote.scopes) || []
      const run = async (work) => {
        if (busy) return
        setBusy(true); setError(''); setNote('')
        try {
          await work()
          await hostsStore.refresh()
        } catch (cause) { setError(cause.message) } finally { setBusy(false) }
      }
      return h('div', { className: 'dshdev-anchor' },
        h('button', {
          type: 'button', className: 'dshdev-chip-host', 'data-testid': 'host-chip', 'aria-expanded': open,
          'aria-label': `${tr('hostChip')}: ${name}`, onClick: () => setOpen(!open),
        },
        h('span', { className: `dshdev-dot ${online ? 'ok' : 'off'}`, 'data-testid': 'host-chip-dot' }),
        h('span', null, name)),
        open ? h('div', { className: 'dshdev-pop', role: 'dialog', 'aria-label': tr('popoverTitle'), 'data-testid': 'host-popover' },
          h('div', { className: 'dshdev-pop-row' }, h('span', null, tr('popoverTitle')), h('strong', null, name)),
          h('div', { className: 'dshdev-pop-row' }, h('span', null, tr('status.online')),
            h('span', { 'data-testid': 'popover-state' }, online ? tr('status.online') : tr('status.offline'))),
          h('div', { className: 'dshdev-pop-row' }, h('span', null, tr('popoverKind')),
            h('span', { 'data-testid': 'popover-kind' }, (remote && remote.kind) || '—')),
          h('div', { className: 'dshdev-pop-row' }, h('span', null, tr('popoverScopes')),
            h('span', { 'data-testid': 'popover-scopes', style: { textAlign: 'right' } },
              scopes.length ? scopes.map((scope) => tr(`scope.${scope}`)).join(', ') : tr('popoverNoScopes'))),
          h('div', { className: 'dshdev-pop-row' }, h('span', null, tr('popoverPaired')),
            h('span', { 'data-testid': 'popover-paired' }, remote && remote.createdAt ? stamp(remote.createdAt) : '—')),
          scopes.includes('terminal') ? null : h('div', { className: 'dshdev-muted', 'data-testid': 'terminal-hint' }, tr('terminalHint')),
          h('div', { className: 'dshdev-muted', style: { marginTop: 8 } }, tr('manageAll')),
          error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
          note ? h('div', { className: 'dshdev-muted', 'data-testid': 'popover-note' }, note) : null,
          h('div', { className: 'dshdev-pop-actions' },
            h('button', { type: 'button', className: 'dshdev-btn primary', 'data-testid': 'reconnect', disabled: busy,
              onClick: () => run(() => post(`/devices/remotes/${encodeURIComponent(id)}/connect`)) },
            busy ? tr('reconnecting') : tr('reconnect')),
            h('button', { type: 'button', className: 'dshdev-btn danger', 'data-testid': 'forget-host', disabled: busy,
              onClick: () => {
                if (!window.confirm(tr('forgetConfirm'))) return
                run(async () => {
                  await request(`/devices/remotes/${encodeURIComponent(id)}`, { method: 'DELETE' })
                  setOpen(false)
                })
              } }, tr('forgetHost')))) : null)
    }

    // Notices above the composer for a remote session. Both are additive: with a
    // reachable host and no model complaint they render nothing at all.
    function SessionBanners(props) {
      useLang()
      const hosts = useHosts(hostsStore)
      const tag = hostTagOf(props.sessionId)
      if (!tag) return null
      const host = hosts.hosts.find((entry) => entry.hostId === tag.hostId)
      const remote = hosts.remotes.find((entry) => entry.id === tag.hostId)
      const online = !!(host && host.online !== false)
      const name = (host && host.hostName) || (remote && remote.name) || tag.hostId
      const banners = []
      if (!online) banners.push(h(OfflineBanner, { key: 'offline', hostId: tag.hostId, rawId: tag.rawId, name, known: !!remote }))
      // The model complaint is read from the session the shell already follows, i.e.
      // from the HOST's answer; nothing here can substitute a local model.
      if (typeof props.useSession === 'function') banners.push(h(ModelStatusBanner, { key: 'model', useSession: props.useSession }))
      // The dock is rendered for a remote session only; an empty dock is invisible
      // (no border, no padding), and each banner decides for itself whether to show.
      return h('div', { className: 'dshdev-dock', 'data-testid': 'session-banners' }, banners)
    }

    function OfflineBanner({ hostId, rawId, name, known }) {
      useLang()
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [error, setError] = React.useState('')
      const remove = async () => {
        if (busy) return
        setBusy(true); setError(''); setNote('')
        try {
          const answer = await request(`/devices/remotes/${encodeURIComponent(hostId)}/sessions/${encodeURIComponent(rawId)}`, { method: 'DELETE' })
          setNote(answer.removed ? tr('localCopyRemoved') : tr('localCopyGone'))
        } catch (cause) { setError(cause.message) } finally { setBusy(false) }
      }
      return h('div', { className: 'dshdev-banner', 'data-testid': 'offline-banner', role: 'status' },
        h('div', { className: 'dshdev-grow' },
          h('strong', null, `${tr('bannerOfflineTitle')} ${name}`),
          h('div', { className: 'dshdev-muted' }, `${tr('bannerReadOnly')} — ${tr('bannerOfflineBody')}`),
          error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
          note ? h('div', { className: 'dshdev-muted', 'data-testid': 'local-copy-note' }, note) : null),
        h('button', { type: 'button', className: 'dshdev-btn', 'data-testid': 'remove-local-copy', disabled: busy || !known, onClick: remove },
          busy ? tr('removeLocalCopyBusy') : tr('removeLocalCopy')))
    }

    function ModelStatusBanner({ useSession }) {
      useLang()
      const session = useSession(ANY) || {}
      const values = (session.projections && session.projections.values) || {}
      const problem = session.modelError ?? values.modelError ?? (values.model && values.model.error)
      const message = typeof problem === 'string' ? problem : (problem && typeof problem.message === 'string' ? problem.message : '')
      if (!message) return null
      return h('div', { className: 'dshdev-banner info', 'data-testid': 'model-status-banner', role: 'status' },
        h('div', { className: 'dshdev-grow' },
          h('strong', null, tr('modelStatus')),
          h('div', { className: 'dshdev-muted' }, message),
          h('div', { className: 'dshdev-muted' }, tr('modelUnavailable'))))
    }

    // A terminal for a remote session needs the device's `terminal` grant. Without
    // it the entry is HIDDEN (not disabled): the hint sits in the host popover,
    // where the granted permissions are listed.
    function RemoteTerminalEntry(props) {
      useLang()
      const hosts = useHosts(hostsStore)
      const tag = hostTagOf(props.sessionId)
      if (!tag) return null
      const remote = hosts.remotes.find((entry) => entry.id === tag.hostId)
      const scopes = (remote && remote.scopes) || []
      if (!scopes.includes('terminal')) return null
      const openTerminal = typeof props.openTerminal === 'function' ? props.openTerminal : nav.openTerminal
      return h('button', { type: 'button', className: 'dshdev-btn', 'data-testid': 'remote-terminal', title: tr('terminalOpen'),
        disabled: !openTerminal, onClick: () => { if (openTerminal) openTerminal(props.sessionId) } }, tr('terminalEntry'))
    }

    // The Devices page's own line about the replacement, so a failed install is
    // visible in the UI instead of only in the console.
    function RemoteGroupingStatus() {
      useLang()
      const status = useRemoteUI()
      return h('div', { className: 'dshdev-card', 'data-testid': 'sidebar-grouping' },
        h('h3', null, tr('sidebarGrouping')),
        h('div', { className: 'dshdev-muted', 'data-testid': 'sidebar-grouping-state' },
          status.grouped ? `${tr('sidebarOn')} (${status.hosts})` : `${tr('sidebarOffState')} — ${status.reason || ''}`))
    }

    /**
     * Spec 008 P2b. Everything here is additive except the grouped sidebar, which
     * shadows the shipped browser: it is installed only while remote routing is
     * live AND a host is connected, and removed again — stock browser back — when
     * either stops being true or the replacement hits an error.
     * @returns {() => void} disposer
     */
    function installRemoteSurfaces(ctx) {
      const dispose = []
      // The grouped-sidebar registration is stateful and the service callbacks below
      // can fire before this function's body finishes, so the helpers are hoisted
      // function declarations over a variable declared first.
      let sidebarEntry = null
      function sidebarActive(snapshot) {
        return !!(snapshot.routing && snapshot.routing.remote === true)
          && snapshot.hosts.length > 0 && !!nav.openSession && !!nav.startSession
      }
      function removeSidebar() {
        if (!sidebarEntry) return
        const entry = sidebarEntry
        sidebarEntry = null
        try { entry?.() } catch { /* already disposed with the declaration */ }
      }
      const register = (slot, meta, component, props) => {
        try {
          dispose.push(ctx.slots.inject(slot, () => ctx.slots.register({ ...meta, name: slot, ...(props ? { inject: props } : {}) }, component)))
        } catch (cause) {
          remoteUI.set({ grouped: false, reason: `${slot}: ${cause && cause.message ? cause.message : 'not available'}` })
        }
      }
      if (typeof ctx.inject === 'function') {
        dispose.push(ctx.inject(['uiWorkspace', 'workspaces'], (scope) => {
          const call = (object, name) => (object && typeof object[name] === 'function' ? object[name].bind(object) : null)
          nav.openSession = call(scope.uiWorkspace, 'openSession')
          nav.startSession = call(scope.uiWorkspace, 'startSession')
          nav.pinSession = call(scope.uiWorkspace, 'pinSession')
          nav.unpinSession = call(scope.uiWorkspace, 'unpinSession')
          nav.archiveSession = call(scope.workspaces, 'archiveSession')
          nav.unarchiveSession = call(scope.workspaces, 'unarchiveSession')
          syncSidebar()
        }))
        // Undocumented but present in the shell: the right column's tab registry.
        dispose.push(ctx.inject(['sidebarRight'], (scope) => {
          nav.openTerminal = (sessionId) => scope.sidebarRight.openTab('terminal', { params: { sessionId } })
        }))
      }
      register('conversation.input.left', { id: 'dsh-ext.devices.host', order: 100, label: tr('hostChip') }, HostChip)
      register('conversation.input.dock', { id: 'dsh-ext.devices.banners', order: 100, label: tr('banners') }, SessionBanners)
      register('conversation.input.right', { id: 'dsh-ext.devices.terminal', order: 100, label: tr('terminalEntry') }, RemoteTerminalEntry,
        () => ({ openTerminal: nav.openTerminal }))

      function syncSidebar() {
        const snapshot = hostsStore.getSnapshot()
        if (sidebarActive(snapshot)) {
          if (sidebarEntry) return
          try {
            sidebarEntry = ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
              name: 'sidebar.workspaces',
              // `sidebar.workspaces` is a single slot and the shipped browser already
              // occupies it at priority 0 (default). Measured on a live Host: a second
              // registration at 0 is refused outright ("already has a registration at
              // priority 0 (registered by tk) — register at a different priority to
              // shadow it (lowest renders)"), which made this feature never render.
              // -1 shadows the stock browser; the slot's own rule says lowest renders.
              priority: -1,
              inject: () => ({
                openSession: nav.openSession, startSession: nav.startSession,
                pinSession: nav.pinSession, unpinSession: nav.unpinSession,
                archiveSession: nav.archiveSession, unarchiveSession: nav.unarchiveSession,
                onError: (message) => { removeSidebar(); remoteUI.set({ grouped: false, reason: message }) },
              }),
            }, GroupedWorkspaces))
            remoteUI.set({ grouped: true, reason: null, hosts: snapshot.hosts.length })
          } catch (cause) {
            sidebarEntry = null
            remoteUI.set({ grouped: false, reason: cause && cause.message ? cause.message : 'not available' })
          }
          return
        }
        // Not active: the stock browser keeps the slot, and the Devices page says
        // why, so a silently missing replacement is impossible to misread.
        if (sidebarEntry) removeSidebar()
        remoteUI.set({ grouped: false, hosts: snapshot.hosts.length,
          // A1.1: the wrapper's own reason (e.g. `dsh-version-mismatch`) is shown, so
          // a refused wrap is never a silently missing feature.
          reason: !(snapshot.routing && snapshot.routing.remote === true)
            ? `multi-host routing is off${snapshot.routing && snapshot.routing.reason ? `: ${snapshot.routing.reason}` : ''}`
            : snapshot.hosts.length === 0 ? 'no remote host is connected'
              : 'the shell provides no workspace actions' })
      }
      dispose.push(hostsStore.subscribe(syncSidebar))
      const refresh = () => { hostsStore.refresh().then(syncSidebar, () => {}) }
      refresh()
      dispose.push(...startPoll(refresh))
      return () => {
        for (const entry of dispose.splice(0)) {
          try { entry?.() } catch { /* teardown must not throw */ }
        }
        removeSidebar()
        for (const key of Object.keys(nav)) nav[key] = null
      }
    }

    // One timer for every surface: /devices/remotes returns the whole host picture,
    // and a second timer would only let the surfaces disagree for a few seconds.
    function startPoll(refresh) {
      const interval = window.setInterval(refresh, 4000)
      return [() => window.clearInterval(interval)]
    }


    // -------------------------------------------------------------- page
    function DevicesPage() {
      useLang()
      const [tab, setTab] = React.useState('allow')
      const tabs = [['allow', tr('tabAllow')], ['connect', tr('tabConnect')]]
      return h('div', { className: 'dshdev' },
        h('h2', null, tr('title')),
        h('div', { className: 'dshdev-tabs', role: 'tablist' }, tabs.map(([id, label]) =>
          h('button', { key: id, type: 'button', role: 'tab', 'aria-selected': tab === id, className: 'dshdev-tab', onClick: () => setTab(id) }, label))),
        tab === 'allow' ? h(AllowTab) : h(ConnectTab))
    }

    function DevicesIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
      h('rect', { x: 3, y: 4, width: 13, height: 9, rx: 1.5 }),
      h('path', { d: 'M7 17h5M9.5 13v4' }),
      h('rect', { x: 17, y: 8, width: 4, height: 11, rx: 1 }))
    }

    const inject = ['slots', 'locale']
    function apply(ctx) {
      ctx.effect(() => {
        const sync = () => setHostLanguage(ctx.locale.getSnapshot().active)
        sync()
        const unsubscribe = ctx.locale.subscribe(sync)
        return () => { unsubscribe(); setHostLanguage('') }
      }, 'devices: host language')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = css
        document.head.appendChild(style)
        return () => style.remove()
      }, 'devices: styles')
      // One settings page per list entry (spec 008 Q1): the page and its icon share an id.
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'dsh-ext.devices', order: 80, label: tr('title') },
        () => h(DevicesPage)))
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register(
        { name: 'settings.section.icon', id: 'dsh-ext.devices', order: 80, label: tr('title') },
        () => h(DevicesIcon)))
      // Spec 008 P2b. Gated on the client context's own capability (`ctx.inject` is
      // how a browser plugin waits for optional services): without it there is no
      // way to reach the workspace/session actions, so nothing is installed and the
      // stock UI stays exactly as shipped.
      if (typeof ctx.inject === 'function') {
        ctx.effect(() => installRemoteSurfaces(ctx), 'devices: remote session surfaces')
      } else {
        remoteUI.set({ grouped: false, reason: 'the shell provides no client services' })
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.testing = { DevicesPage, AllowTab, ConnectTab, RemoteDetail, AddDeviceForm, AddDeviceDialog, OtpDialog, PendingRequests, ScopePicker, AdvancedLimits, ALL_SCOPES, SCOPE_PRESETS, request, tr, DICT, setHostLanguage,
      // spec 008 P2b
      GroupedWorkspaces, GroupedTree, HostChip, SessionBanners, OfflineBanner, ModelStatusBanner, RemoteTerminalEntry,
      RemoteGroupingStatus, hostsStore, remoteUI, hostTagOf, HOST_TAG }
    return module.exports
  },
})
