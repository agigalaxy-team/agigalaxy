package runtimelog

import (
	"compress/gzip"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

type rotatingSink struct {
	directory      string
	file           *os.File
	size           int64
	configuration  Configuration
	now            func() time.Time
	day            string
	rotations      uint64
	rotationFailed bool
}

func newRotatingSink(component string, c Configuration, now func() time.Time) (*rotatingSink, error) {
	dir := filepath.Join(c.Directory, component+"-"+c.Instance)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, fault.New("runtime_log_directory_invalid", 500)
	}
	info, e := os.Lstat(dir)
	if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		return nil, fault.New("runtime_log_directory_invalid", 500)
	}
	s := &rotatingSink{directory: dir, configuration: c, now: now, day: now().Local().Format("2006-01-02")}
	if e = s.open(); e != nil {
		return nil, fault.New("runtime_log_file_unavailable", 500)
	}
	return s, nil
}
func (s *rotatingSink) open() error {
	path := filepath.Join(s.directory, "runtime.jsonl")
	info, e := os.Lstat(path)
	if e == nil && (!info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0)) {
		return fault.New("runtime_log_file_invalid", 500)
	}
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	s.file, e = os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
	if e == nil {
		info, e = s.file.Stat()
		if e == nil {
			s.size = info.Size()
		} else {
			s.file.Close()
		}
	}
	return e
}
func (s *rotatingSink) Write(line []byte) (int, error) {
	day := s.now().Local().Format("2006-01-02")
	if s.size > 0 && (s.size >= s.configuration.RotateBytes || day != s.day) {
		if e := s.rotate(); e != nil {
			s.rotationFailed = true
			return 0, e
		}
	}
	s.day = day
	n, e := s.file.Write(line)
	s.size += int64(n)
	return n, e
}
func (s *rotatingSink) archive(index int) string {
	return filepath.Join(s.directory, fmt.Sprintf("runtime.%d.jsonl.gz", index))
}
func (s *rotatingSink) rotate() error {
	if e := s.file.Close(); e != nil {
		return e
	}
	s.file = nil
	source, e := os.Open(filepath.Join(s.directory, "runtime.jsonl"))
	if e != nil {
		return e
	}
	defer source.Close()
	temp, e := os.OpenFile(filepath.Join(s.directory, "runtime.rotate.tmp"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer os.Remove(temp.Name())
	zip := gzip.NewWriter(temp)
	_, copyErr := io.Copy(zip, source)
	zipErr := zip.Close()
	fileErr := temp.Close()
	if copyErr != nil {
		return copyErr
	}
	if zipErr != nil {
		return zipErr
	}
	if fileErr != nil {
		return fileErr
	}
	// Rotate only exact numbered owned files; adjacent files are never enumerated
	// for deletion or interpreted as paths by an imported history manifest.
	for i := s.configuration.MaxFiles; i >= 1; i-- {
		path := s.archive(i)
		if info, e := os.Lstat(path); e == nil {
			if !info.Mode().IsRegular() {
				return fault.New("runtime_log_archive_invalid", 500)
			}
			if i == s.configuration.MaxFiles {
				if e = os.Remove(path); e != nil {
					return e
				}
			} else {
				if e = os.Rename(path, s.archive(i+1)); e != nil {
					return e
				}
			}
		} else if !os.IsNotExist(e) {
			return e
		}
	}
	if e = os.Rename(temp.Name(), s.archive(1)); e != nil {
		return e
	}
	if e = os.Truncate(filepath.Join(s.directory, "runtime.jsonl"), 0); e != nil {
		return e
	}
	if e = s.open(); e != nil {
		return e
	}
	s.rotations++
	return nil
}
func (s *rotatingSink) Close() error {
	if s.file != nil {
		return s.file.Close()
	}
	return nil
}
