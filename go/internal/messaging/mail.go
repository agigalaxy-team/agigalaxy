// Package messaging owns the existing official messaging plans, run recipients
// and SMTP attempts. A queue retry cannot turn an unknown submission into a new send.
package messaging

import (
	"bytes"
	"embed"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Original shared letterhead, footer and responsive rules. Node is not needed
// at runtime; ordinary user text only enters escaped body slots.
//
//go:embed assets/mail.html assets/mail.txt
var mailAssets embed.FS

type MailIdentity struct {
	Name, Address, ReplyTo string
	Automated              bool
}

var OfficialMailIdentities = map[string]MailIdentity{
	"account":   {"AGI Galaxy 账户", "account@agigalaxy.org", "team@agigalaxy.org", true},
	"notice":    {"AGI Galaxy 通知", "notice@agigalaxy.org", "team@agigalaxy.org", true},
	"community": {"AGI Galaxy 社区", "community@agigalaxy.org", "team@agigalaxy.org", true},
	"updates":   {"AGI Galaxy 更新", "updates@agigalaxy.org", "team@agigalaxy.org", true},
	"team":      {"AGI Galaxy 团队", "team@agigalaxy.org", "team@agigalaxy.org", false},
}

type MailMessage struct {
	To, SenderKey, Subject, Title string
	Paragraphs                    []string
	Note, Language, MessageID     string
}
type RenderedMail struct{ Subject, HTML, Text string }

const emailFont = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif"

func escape(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;").Replace(value)
}
func table(content string) string {
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">` + "\n" + content + "\n</table>"
}
func row(content, style string) string {
	return `<tr><td style="` + style + `">` + content + `</td></tr>`
}
func paragraph(content, style string) string {
	return `<p style="margin:0;font-family:` + emailFont + `;font-size:15px;line-height:26.25px;color:#505361;` + style + `">` + content + `</p>`
}
func RenderMail(message MailMessage, year int) (RenderedMail, error) {
	identity, ok := OfficialMailIdentities[message.SenderKey]
	if !ok {
		return RenderedMail{}, fault.New("smtp_sender_invalid", 400)
	}
	language := message.Language
	if language == "" {
		language = "zh-CN"
	}
	labels := []string{"系统通知", "关于银河", "隐私", "使用说明", "系统邮件，请勿直接回复。", "联系银河团队", "如需继续沟通，可直接回复本邮件。"}
	if strings.HasPrefix(strings.ToLower(language), "en") {
		labels = []string{"Notification", "About Galaxy", "Privacy", "User guide", "This is an automated system email. Please do not reply directly.", "Contact the Galaxy team", "You can reply to this email to continue the conversation."}
	}
	reply := labels[4]
	if !identity.Automated {
		reply = labels[6]
	}
	heading := `<h1 class="galaxy-mail-title" style="margin:0;font-family:` + emailFont + `;font-size:24px;line-height:35px;font-weight:600;letter-spacing:-.45px;color:#282a34;">` + escape(message.Title) + `</h1>`
	body := row(heading, "padding-bottom:21px;")
	plain := []string{}
	if message.Title != "" {
		plain = append(plain, message.Title)
	}
	for i, value := range message.Paragraphs {
		style := ""
		if i < len(message.Paragraphs)-1 {
			style = "padding-bottom:13px;"
		}
		body += row(paragraph(escape(value), ""), style)
		if value != "" {
			plain = append(plain, value)
		}
	}
	if message.Note != "" {
		body += row(paragraph(escape(message.Note), "font-size:12px;line-height:21px;color:#6d6e7b;"), "padding-top:23px;")
		plain = append(plain, message.Note)
	}
	if year == 0 {
		year = time.Now().UTC().Year()
	}
	html, _ := mailAssets.ReadFile("assets/mail.html")
	text, _ := mailAssets.ReadFile("assets/mail.txt")
	pairs := []string{"@@LANGUAGE@@", escape(language), "@@CATEGORY@@", escape(labels[0]), "@@TITLE@@", escape(message.Title), "@@ABOUT@@", escape(labels[1]), "@@PRIVACY@@", escape(labels[2]), "@@GUIDE@@", escape(labels[3]), "@@REPLY@@", escape(reply), "@@CONTACT@@", escape(labels[5]), "@@YEAR@@", strconv.Itoa(year), "@@BODY@@", table(body)}
	htmlBody := strings.NewReplacer(pairs...).Replace(string(html))
	plainPairs := []string{"@@CATEGORY@@", labels[0], "@@ABOUT@@", labels[1], "@@PRIVACY@@", labels[2], "@@GUIDE@@", labels[3], "@@REPLY@@", reply, "@@CONTACT@@", labels[5], "@@YEAR@@", strconv.Itoa(year), "@@BODY@@", strings.Join(plain, "\n\n")}
	return RenderedMail{Subject: strings.NewReplacer("\r", " ", "\n", " ").Replace(message.Subject), HTML: htmlBody, Text: strings.NewReplacer(plainPairs...).Replace(string(text))}, nil
}

var emailPattern = regexp.MustCompile(`^[^\s@<>\r\n]+@[^\s@<>\r\n]+$`)
var messageIDPattern = regexp.MustCompile(`^<[A-Za-z0-9._-]{1,200}@(messages\.)?agigalaxy\.org>$`)

func ComposeMail(message MailMessage, at time.Time) ([]byte, error) {
	if len(message.To) > 320 || !emailPattern.MatchString(message.To) || !messageIDPattern.MatchString(message.MessageID) {
		return nil, fault.New("smtp_message_invalid", 400)
	}
	rendered, e := RenderMail(message, at.UTC().Year())
	if e != nil {
		return nil, e
	}
	identity := OfficialMailIdentities[message.SenderKey]
	var body bytes.Buffer
	parts := multipart.NewWriter(&body)
	for _, part := range []struct{ kind, text string }{{"text/plain", rendered.Text}, {"text/html", rendered.HTML}} {
		header := textproto.MIMEHeader{}
		header.Set("Content-Type", part.kind+`; charset="UTF-8"`)
		header.Set("Content-Transfer-Encoding", "quoted-printable")
		writer, e := parts.CreatePart(header)
		if e != nil {
			return nil, fault.New("smtp_message_invalid", 400)
		}
		encoded := quotedprintable.NewWriter(writer)
		if _, e = encoded.Write([]byte(part.text)); e != nil {
			return nil, fault.New("smtp_message_invalid", 400)
		}
		if e = encoded.Close(); e != nil {
			return nil, fault.New("smtp_message_invalid", 400)
		}
	}
	parts.Close()
	from := (&mail.Address{Name: identity.Name, Address: identity.Address}).String()
	reply := (&mail.Address{Name: "AGI Galaxy 团队", Address: identity.ReplyTo}).String()
	to := (&mail.Address{Address: message.To}).String()
	var header bytes.Buffer
	fmt.Fprintf(&header, "From: %s\r\nReply-To: %s\r\nTo: %s\r\nSubject: %s\r\nMessage-ID: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=%s\r\n", from, reply, to, mime.QEncoding.Encode("UTF-8", rendered.Subject), message.MessageID, at.Format(time.RFC1123Z), parts.Boundary())
	if identity.Automated {
		header.WriteString("Auto-Submitted: auto-generated\r\n")
	}
	header.WriteString("\r\n")
	header.Write(body.Bytes())
	return header.Bytes(), nil
}
