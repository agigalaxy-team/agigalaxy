/* Local examples only: no model call, authentication, storage or network request. */
(() => {
  "use strict";
  const root = document.querySelector(".galaxy-home[data-home-example]");
  if (!root) return;
  const example = JSON.parse(root.dataset.homeExample);
  const one = selector => root.querySelector(selector);
  const all = selector => Array.from(root.querySelectorAll(selector));
  const tabs = all("[data-gh-tab]");
  let miniSource = null;

  function pressed(selector, value, key) {
    all(selector).forEach(button => button.setAttribute("aria-pressed", String(button.dataset[key] === value)));
  }

  function selectTab(value, moveFocus = false) {
    tabs.forEach(tab => {
      const selected = tab.dataset.ghTab === value;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
      if (selected && moveFocus) tab.focus({ preventScroll: true });
    });
  }

  function resetSource(button) {
    button.setAttribute("aria-expanded", "false");
    button.querySelector("[data-gh-source-summary]").hidden = false;
    button.querySelector(".gh-source-excerpt").hidden = true;
  }

  function answerWith(answer, questionKey = null) {
    one("[data-gh-question-copy]").textContent = answer.question;
    one("[data-gh-answer]").textContent = answer.answer;
    all("[data-gh-source]").forEach(button => {
      resetSource(button);
      button.hidden = !answer.sources.includes(button.dataset.ghSource);
    });
    all(".gh-source-linked").forEach(item => item.classList.remove("gh-source-linked"));
    pressed("[data-gh-question]", questionKey, "ghQuestion");
  }

  function toggleFeature(key, open) {
    const article = one(`[data-gh-feature="${key}"]`);
    if (!article) return;
    const front = article.querySelector("[data-gh-open]");
    const back = article.querySelector(".gh-feature-back");
    front.setAttribute("aria-expanded", String(open));
    front.hidden = open;
    back.hidden = !open;
    const target = open ? article.querySelector("[data-gh-close]") : front;
    target.focus({ preventScroll: true });
  }

  function updateMaterial(key) {
    const material = example.materials[key];
    if (!material) return;
    for (const field of ["title", "copy", "source", "condition"]) {
      one(`[data-gh-data-${field}]`).textContent = material[field];
    }
    pressed("[data-gh-data]", key, "ghData");
  }

  function updateMiniAI() {
    const selected = all("[data-gh-allowed]:checked").map(input => input.dataset.ghAllowed);
    const has = key => selected.includes(key);
    one("[data-gh-mini-answer]").textContent = has("sample") && has("method")
      ? "先核对样本出处，再用整理方法处理字段。引用保留来源。"
      : has("sample") ? "可按地点与日期整理示例样本，并保留原始出处。"
        : has("method") ? "方法可用于字段整理；还需要你提供获准的样本资料。"
          : "先选一份获准的示例资料。";
    if (!selected.includes(miniSource)) miniSource = null;
    all("[data-gh-mini-source]").forEach(button => {
      button.hidden = !has(button.dataset.ghMiniSource);
      button.setAttribute("aria-expanded", String(button.dataset.ghMiniSource === miniSource));
    });
    const excerpt = one("#gh-mini-excerpt");
    excerpt.hidden = miniSource === null;
    excerpt.textContent = miniSource ? example.materials[miniSource].copy : "";
  }

  function selectEntry(key) {
    const entry = example.entries[key];
    if (!entry) return;
    for (const field of ["label", "title", "copy"]) {
      one(`[data-gh-entry-${field}]`).textContent = entry[field];
    }
    const link = one("[data-gh-entry-link]");
    link.textContent = entry.action;
    link.setAttribute("href", entry.href);
    pressed("[data-gh-entry]", key, "ghEntry");
  }

  root.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || !root.contains(button)) return;
    const data = button.dataset;
    if (data.ghTab) selectTab(data.ghTab);
    else if (data.ghRecord) {
      const item = example.items[data.ghRecord];
      const open = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(open));
      button.querySelector(".gh-record-front").hidden = open;
      button.querySelector(".gh-record-back").hidden = !open;
      answerWith({ question: item.question, answer: item.answer, sources: [data.ghRecord] });
    } else if (data.ghExcerpt) {
      const open = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(open));
      button.querySelector(".gh-excerpt").hidden = !open;
      const hint = button.querySelector(".gh-excerpt-hint");
      if (hint) hint.hidden = open;
    } else if (data.ghQuestion) answerWith(example.questions[data.ghQuestion], data.ghQuestion);
    else if (data.ghSource) {
      const open = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(open));
      button.querySelector("[data-gh-source-summary]").hidden = open;
      button.querySelector(".gh-source-excerpt").hidden = !open;
    } else if (data.ghOpen) toggleFeature(data.ghOpen, true);
    else if (data.ghClose) toggleFeature(data.ghClose, false);
    else if (data.ghData) updateMaterial(data.ghData);
    else if (data.ghContext) {
      one("[data-gh-context-label]").textContent = data.ghContext === "web" ? "网页入口 · 示例" : "Agent 入口 · 示例";
      pressed("[data-gh-context]", data.ghContext, "ghContext");
    } else if (data.ghMiniSource) {
      miniSource = miniSource === data.ghMiniSource ? null : data.ghMiniSource;
      updateMiniAI();
    } else if (data.ghEntry) selectEntry(data.ghEntry);
  });

  root.addEventListener("change", event => {
    if (event.target.matches("[data-gh-allowed]")) updateMiniAI();
  });

  root.addEventListener("keydown", event => {
    const tab = event.target.closest("[data-gh-tab]");
    if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.ghTab, true);
    }
    if (event.key === "Escape") {
      const article = event.target.closest("[data-gh-feature]");
      if (article && !article.querySelector(".gh-feature-back").hidden) {
        event.preventDefault();
        toggleFeature(article.dataset.ghFeature, false);
      }
    }
  });

  function associateSource(button, active) {
    if (!button) return;
    const key = button.dataset.ghSource;
    all(`[data-gh-record="${key}"], [data-gh-excerpt="${key}"]`).forEach(item => {
      item.classList.toggle("gh-source-linked", active);
    });
  }
  root.addEventListener("pointerover", event => {
    const source = event.target.closest("[data-gh-source]");
    if (source && !source.contains(event.relatedTarget)) associateSource(source, true);
  });
  root.addEventListener("pointerout", event => {
    const source = event.target.closest("[data-gh-source]");
    if (source && !source.contains(event.relatedTarget) && !source.contains(document.activeElement)) associateSource(source, false);
  });
  root.addEventListener("focusin", event => associateSource(event.target.closest("[data-gh-source]"), true));
  root.addEventListener("focusout", event => {
    const source = event.target.closest("[data-gh-source]");
    if (source && !source.contains(event.relatedTarget)) associateSource(source, false);
  });
})();
