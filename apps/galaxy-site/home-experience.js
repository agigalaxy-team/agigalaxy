/* Local examples only: no model call, authentication, storage or network request. */
export function attachHomeExperience(root) {
  "use strict";
  if (!root) return () => {};
  const disposers = [];
  const listen = (target, type, callback) => { target.addEventListener(type, callback); disposers.push(() => target.removeEventListener(type, callback)); };
  const example = JSON.parse(root.dataset.homeExample);
  const all = selector => Array.from(root.querySelectorAll(selector));
  const one = selector => root.querySelector(selector);
  const tabs = all("[data-gh-tab]");
  const pinned = new Set();
  const announcement = one("[data-gh-announcement]");

  function announce(text) {
    announcement.textContent = text;
  }

  function associate(key, active) {
    if (!key) return;
    all("[data-gh-association]").forEach(element => {
      if (element.dataset.ghAssociation === key) {
        element.classList.toggle("gh-associated", active || pinned.has(key));
      }
    });
  }

  function pinAssociation(key) {
    if (!key) return;
    const scope = key.split("-")[0];
    for (const previous of pinned) {
      if (previous.split("-")[0] === scope && previous !== key) {
        pinned.delete(previous);
        associate(previous, false);
      }
    }
    pinned.add(key);
    associate(key, true);
  }

  function activateTab(tab, moveFocus = false) {
    const group = tab.closest('[role="tablist"]');
    const siblings = Array.from(group.querySelectorAll("[data-gh-tab]"));
    siblings.forEach(candidate => {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(candidate.getAttribute("aria-controls"));
      if (panel && root.contains(panel)) panel.hidden = !selected;
    });
    if (moveFocus) tab.focus({ preventScroll: true });
  }

  function selectConcept(key) {
    if (!Object.prototype.hasOwnProperty.call(example.concepts, key)) return;
    all("[data-gh-concept]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.ghConcept === key));
    });
    one(".gh-hero-network").dataset.ghConceptCurrent = key;
    one("[data-gh-concept-copy]").textContent = example.concepts[key];
  }

  function selectEntry(key) {
    const entry = example.entries[key];
    if (!entry) return;
    all("[data-gh-entry]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.ghEntry === key));
    });
    one(".gh-access-network").dataset.ghEntryCurrent = key;
    one("[data-gh-entry-title]").textContent = entry.title;
    one("[data-gh-entry-detail]").textContent = entry.detail;
    const link = one("[data-gh-entry-link]");
    link.textContent = entry.action;
    link.href = entry.href;
  }

  listen(root, "click", event => {
    const button = event.target.closest("button");
    if (!button || !root.contains(button)) return;
    if (button.hasAttribute("data-gh-tab")) {
      activateTab(button);
    } else if (button.dataset.ghReference) {
      const tab = tabs.find(candidate => candidate.getAttribute("aria-controls") === button.dataset.ghReference);
      if (tab) {
        activateTab(tab);
        pinAssociation(button.dataset.ghAssociate);
        announce("已在本模块显示对应的示例原文。");
      }
    } else if (button.dataset.ghLocate) {
      const original = document.getElementById(button.dataset.ghLocate);
      if (original && root.contains(original)) {
        pinAssociation(button.dataset.ghAssociate);
        original.focus({ preventScroll: true });
        announce("已标记当前内容对应的原始依据。");
      }
    } else if (button.dataset.ghConcept) {
      selectConcept(button.dataset.ghConcept);
    } else if (button.dataset.ghEntry) {
      selectEntry(button.dataset.ghEntry);
    }
  });

  listen(root, "keydown", event => {
    const tab = event.target.closest("[data-gh-tab]");
    if (!tab) return;
    const group = tab.closest('[role="tablist"]');
    const siblings = Array.from(group.querySelectorAll("[data-gh-tab]"));
    const vertical = group.getAttribute("aria-orientation") === "vertical";
    const previous = vertical ? "ArrowUp" : "ArrowLeft";
    const next = vertical ? "ArrowDown" : "ArrowRight";
    if (![previous, next, "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = siblings.indexOf(tab);
    const target = event.key === "Home" ? 0 : event.key === "End" ? siblings.length - 1
      : (index + (event.key === next ? 1 : -1) + siblings.length) % siblings.length;
    activateTab(siblings[target], true);
  });

  function preview(target) {
    const concept = target.closest("[data-gh-concept]");
    if (concept) selectConcept(concept.dataset.ghConcept);
    const node = target.closest(".gh-entry-node");
    if (node) selectEntry(node.dataset.ghEntry);
    const reference = target.closest("[data-gh-associate]");
    if (reference) associate(reference.dataset.ghAssociate, true);
  }

  listen(root, "pointerover", event => {
    if (event.pointerType !== "touch") preview(event.target);
  });
  listen(root, "focusin", event => preview(event.target));
  listen(root, "pointerout", event => {
    const reference = event.target.closest("[data-gh-associate]");
    if (reference && !reference.contains(event.relatedTarget) && !reference.contains(document.activeElement)) {
      associate(reference.dataset.ghAssociate, false);
    }
  });
  listen(root, "focusout", event => {
    const reference = event.target.closest("[data-gh-associate]");
    if (reference && !reference.contains(event.relatedTarget)) associate(reference.dataset.ghAssociate, false);
  });
  return () => disposers.forEach(dispose => dispose());
}
