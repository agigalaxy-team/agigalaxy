//go:build windows

package nativebridge

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type loginWindowClass struct {
	Size, Style                        uint32
	Procedure                          uintptr
	ClassExtra, WindowExtra            int32
	Instance, Icon, Cursor, Background uintptr
	MenuName, ClassName                *uint16
	SmallIcon                          uintptr
}
type loginWindowMessage struct {
	Window         uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	X, Y           int32
	Private        uint32
}

func WatchLoginSession(ctx context.Context, onEnd context.CancelFunc) (LoginSession, error) {
	kernel := windows.NewLazySystemDLL("kernel32.dll")
	var sessionID uint32
	valid, _, _ := kernel.NewProc("ProcessIdToSessionId").Call(uintptr(os.Getpid()), uintptr(unsafe.Pointer(&sessionID)))
	if valid == 0 {
		return LoginSession{}, errors.New("native_login_session_unavailable")
	}
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		user := windows.NewLazySystemDLL("user32.dll")
		wts := windows.NewLazySystemDLL("wtsapi32.dll")
		destroy := user.NewProc("DestroyWindow")
		quit := user.NewProc("PostQuitMessage")
		defWindow := user.NewProc("DefWindowProcW")
		callback := syscall.NewCallback(func(hwnd uintptr, message uint32, wparam, lparam uintptr) uintptr {
			switch message {
			case 0x02B1: // WM_WTSSESSION_CHANGE
				if wparam == 6 && uint32(lparam) == sessionID {
					onEnd()
				}
			case 0x0011:
				return 1 // WM_QUERYENDSESSION: never obstruct logout.
			case 0x0016:
				if wparam != 0 {
					onEnd()
				} // WM_ENDSESSION
			case 0x0010:
				destroy.Call(hwnd)
				return 0
			case 0x0002:
				quit.Call(0)
				return 0
			}
			result, _, _ := defWindow.Call(hwnd, uintptr(message), wparam, lparam)
			return result
		})
		name, _ := windows.UTF16PtrFromString(fmt.Sprintf("GalaxyLoginLifecycle_%d", os.Getpid()))
		instance, _, _ := kernel.NewProc("GetModuleHandleW").Call(0)
		class := loginWindowClass{Procedure: callback, Instance: instance, ClassName: name}
		class.Size = uint32(unsafe.Sizeof(class))
		atom, _, _ := user.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&class)))
		if atom == 0 {
			ready <- errors.New("native_login_session_unavailable")
			return
		}
		defer user.NewProc("UnregisterClassW").Call(uintptr(unsafe.Pointer(name)), instance)
		// This is an invisible top-level window, so WM_ENDSESSION is received.
		hwnd, _, _ := user.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(name)), 0, 0, 0, 0, 0, 0, 0, instance, 0)
		if hwnd == 0 {
			ready <- errors.New("native_login_session_unavailable")
			return
		}
		registered, _, _ := wts.NewProc("WTSRegisterSessionNotification").Call(hwnd, 0)
		if registered == 0 {
			destroy.Call(hwnd)
			ready <- errors.New("native_login_session_unavailable")
			return
		}
		defer wts.NewProc("WTSUnRegisterSessionNotification").Call(hwnd)
		stop := context.AfterFunc(ctx, func() { user.NewProc("PostMessageW").Call(hwnd, 0x0010, 0, 0) })
		defer stop()
		ready <- nil
		var message loginWindowMessage
		for {
			result, _, _ := user.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
			if int32(result) <= 0 {
				return
			}
			user.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&message)))
			user.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&message)))
		}
	}()
	select {
	case <-ctx.Done():
		return LoginSession{}, ctx.Err()
	case err := <-ready:
		if err != nil {
			return LoginSession{}, err
		}
		return LoginSession{Kind: "windows-wts", ID: strconv.FormatUint(uint64(sessionID), 10)}, nil
	}
}
