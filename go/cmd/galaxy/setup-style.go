package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

func setupAccent(output *os.File) (string, func()) {
	if !humanOutput || os.Getenv("NO_COLOR") != "" || os.Getenv("TERM") == "dumb" {
		return "", func() {}
	}
	info, err := output.Stat()
	if err != nil || info.Mode()&os.ModeCharDevice == 0 {
		return "", func() {}
	}
	restore, ok := setupTerminalColor(output)
	if !ok {
		return "", func() {}
	}
	background := os.Getenv("COLORFGBG")
	background = background[strings.LastIndex(background, ";")+1:]
	index, _ := strconv.Atoi(background)
	light := index >= 7 && index <= 15 && index != 8
	term, color := os.Getenv("TERM"), os.Getenv("COLORTERM")
	switch {
	case color == "truecolor" || color == "24bit" || os.Getenv("WT_SESSION") != "":
		if light {
			return "\x1b[38;2;164;65;104m", restore
		}
		return "\x1b[38;2;239;179;207m", restore
	case strings.Contains(term, "256color"):
		if light {
			return "\x1b[38;5;132m", restore
		}
		return "\x1b[38;5;218m", restore
	default:
		return "\x1b[35m", restore
	}
}

func setupHeading(output *os.File, title string) {
	accent, restore := setupAccent(output)
	defer restore()
	if accent != "" {
		fmt.Fprintf(output, "%s银河 / AGI GALAXY\x1b[0m  %s\n", accent, title)
	}
}

func setupHostOption(number int, label string) {
	accent, restore := setupAccent(os.Stderr)
	defer restore()
	if accent == "" {
		fmt.Fprintf(os.Stderr, "%d. %s\n", number, label)
		return
	}
	fmt.Fprintf(os.Stderr, "%s%d.\x1b[0m %s\n", accent, number, label)
}
