// Progressive enhancement: links and the menu also work without JavaScript.
const menu = document.querySelector('.mobile-menu');
document.addEventListener('pointerdown', event => {
  if (menu?.open && !menu.contains(event.target)) menu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu?.open) {
    menu.open = false;
    menu.querySelector('summary')?.focus();
  }
});
