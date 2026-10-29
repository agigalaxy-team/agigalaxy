import Foundation
import AppKit
import UserNotifications
import CoreFoundation
import Darwin

// Bundled local helper, never a daemon. All protocol/state work runs on main.
// Notification bodies are fixed generic text: no source material, IDs or URLs.
let expectedBundle = "org.galaxy.local-notifications"
func emit(_ value: [String: Any]) {
    var result = value
    result["version"] = 1
    result["bundleId"] = expectedBundle
    guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
func finishProcess() {
    emit(["event": "closed"])
    exit(0)
}
func unavailable(_ reason: String) {
    emit(["event": "unavailable", "reason": reason])
    finishProcess()
}
guard CommandLine.arguments == [CommandLine.arguments[0], "--stdio-v1"] else {
    unavailable("macos_notification_input_invalid")
}
guard Bundle.main.bundleIdentifier == expectedBundle && Bundle.main.bundleURL.pathExtension == "app" else {
    unavailable("macos_notification_bundle_required")
}
guard #available(macOS 10.14, *) else {
    unavailable("macos_notification_service_unavailable")
}

@available(macOS 10.14, *)
final class NotificationSession: NSObject, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()
    var started = false, stopping = false, addPending = false, accepted = false
    var originalID: String?
    var deadline: Timer?
    var signals: [DispatchSourceSignal] = []
    override init() {
        super.init()
        center.delegate = self
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { [weak self] in self?.stop() }
            source.resume(); signals.append(source)
        }
        deadline = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { [weak self] _ in self?.stop() }
    }
    // Never convert delivery or user selection into a Galaxy human-read ACK.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler complete: @escaping (UNNotificationPresentationOptions) -> Void) {
        complete([.alert])
    }
    func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue == floor(number.doubleValue) else { return nil }
        return number.intValue
    }
    func receive(_ data: Data) {
        guard let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              integer(request["version"]) == 1, let mode = request["mode"] as? String else {
            stop(); return
        }
        if mode == "close" && Set(request.keys) == Set(["version", "mode"]) { stop(); return }
        guard !started && !stopping else { stop(); return }
        if mode == "probe" || mode == "permission" {
            guard Set(request.keys) == Set(["version", "mode"]) else { stop(); return }
            started = true
            center.getNotificationSettings { settings in
                DispatchQueue.main.async {
                    guard !self.stopping else { self.stop(); return }
                    if mode == "permission" && settings.authorizationStatus == .notDetermined {
                        // Called only from a separately confirmed local permission
                        // action. No provisional, sound, badge, push or background
                        // entitlement is requested.
                        self.center.requestAuthorization(options: [.alert]) { _, _ in
                            self.center.getNotificationSettings { current in
                                DispatchQueue.main.async { self.capabilities(current) }
                            }
                        }
                    } else { self.capabilities(settings) }
                }
            }
            return
        }
        guard mode == "show", Set(request.keys) == Set(["version", "mode", "promptId", "eventCount"]),
              let id = request["promptId"] as? String, UUID(uuidString: id) != nil,
              let count = integer(request["eventCount"]), (1...20).contains(count) else {
            unavailable("macos_notification_input_invalid")
            return
        }
        started = true; originalID = id
        center.getNotificationSettings { settings in
            DispatchQueue.main.async {
                guard !self.stopping else { self.stop(); return }
                guard settings.authorizationStatus == .authorized && settings.alertSetting == .enabled else {
                    unavailable("macos_notification_permission_required")
                    return
                }
                let content = UNMutableNotificationContent()
                content.title = "Galaxy"
                content.body = "There are new items to review. Return to the Galaxy notification inbox."
                content.sound = nil
                let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
                self.addPending = true
                self.center.add(request) { error in
                    DispatchQueue.main.async {
                        self.addPending = false
                        if error != nil {
                            if self.stopping { self.stop() } else { unavailable("macos_notification_service_unavailable") }
                            return
                        }
                        self.accepted = true
                        emit(["event": "accepted", "notificationId": id, "evidence": "UNUserNotificationCenter.add-completion"])
                        if self.stopping { self.withdraw() } else {
                            self.deadline?.invalidate()
                            self.deadline = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in self?.stop() }
                        }
                    }
                }
            }
        }
    }
    func capabilities(_ settings: UNNotificationSettings) {
        guard !stopping else { stop(); return }
        let permission: String
        switch settings.authorizationStatus {
        case .authorized: permission = "authorized"
        case .denied: permission = "denied"
        case .notDetermined: permission = "not-determined"
        default: permission = "unknown"
        }
        emit(["event": "capabilities", "channel": "macos-user-notifications",
              "available": settings.authorizationStatus == .authorized && settings.alertSetting == .enabled,
              "permission": permission, "alertsEnabled": settings.alertSetting == .enabled,
              "displayEvidence": "none", "recall": "app-original-identifier"])
        finishProcess()
    }
    func stop() {
        stopping = true; deadline?.invalidate()
        if addPending { return } // Add completion must settle before exact recall.
        if accepted { withdraw() } else { finishProcess() }
    }
    var withdrawing = false
    func withdraw() {
        guard !withdrawing, let id = originalID else { return }
        withdrawing = true
        // Only this process's original request, never all app notifications.
        center.removePendingNotificationRequests(withIdentifiers: [id])
        center.removeDeliveredNotifications(withIdentifiers: [id])
        observeAbsence(id, until: Date().addingTimeInterval(1))
    }
    func observeAbsence(_ id: String, until: Date) {
        center.getPendingNotificationRequests { pending in
            self.center.getDeliveredNotifications { delivered in
                DispatchQueue.main.async {
                    let absent = !pending.contains { $0.identifier == id } &&
                                 !delivered.contains { $0.request.identifier == id }
                    if absent || Date() >= until {
                        // Observation describes only these two app snapshots.
                        // Remove is asynchronous and offers no deletion ACK.
                        emit(["event": "withdrawn", "notificationId": id, "requested": true, "observedAbsence": absent])
                        finishProcess()
                    } else {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.observeAbsence(id, until: until) }
                    }
                }
            }
        }
    }
}
if #available(macOS 10.14, *) {
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
    let session = NotificationSession()
    DispatchQueue.global(qos: .utility).async {
        var input = Data()
        while true {
            let byte = FileHandle.standardInput.readData(ofLength: 1)
            if byte.isEmpty { DispatchQueue.main.async { session.stop() }; break }
            if byte[0] == 10 {
                let line = input; input.removeAll(keepingCapacity: true)
                DispatchQueue.main.async { session.receive(line) }
            } else {
                input.append(byte)
                if input.count > 512 { DispatchQueue.main.async { session.stop() }; break }
            }
        }
    }
    RunLoop.main.run()
}

