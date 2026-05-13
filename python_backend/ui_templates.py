GLOBAL_UI_STYLE = """
<style id="global-world-class-ui">
:root{
  --ui-focus-ring: 0 0 0 3px rgba(189,116,1,.24);
  --ui-border: rgba(17,24,39,.22);
  --ui-text: #18212f;
  --ui-surface: #ffffff;
  --ui-muted: #5f6c80;
  --ui-primary: #0f766e;
  --ui-primary-hover: #115e59;
  --ui-danger: #b42318;
  --ui-success: #067647;
}
html, body{
  color: var(--ui-text);
}
.ui-alert{
  border: 1px solid var(--ui-border);
  border-left-width: 4px;
  border-radius: 12px;
  padding: 10px 12px;
  background: #f7faf9;
  color: var(--ui-text);
}
.ui-alert.is-empty{
  display: none;
}
.ui-alert.error{
  border-color: var(--ui-danger);
  background: #fef3f2;
  color: #7a271a;
}
.ui-alert.success{
  border-color: var(--ui-success);
  background: #ecfdf3;
  color: #085d3a;
}
.ui-btn{
  border-radius: 12px;
  font-weight: 600;
  transition: transform .08s ease, filter .15s ease, box-shadow .15s ease;
}
.ui-btn:hover{
  filter: brightness(.98);
}
.ui-btn:active{
  transform: translateY(1px);
}
.ui-field{
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-surface);
  transition: border-color .15s ease, box-shadow .15s ease;
}
.ui-field::placeholder{
  color: var(--ui-muted);
}
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible{
  outline: none !important;
  box-shadow: var(--ui-focus-ring) !important;
}
label{
  font-weight: 600;
}
</style>
"""


GLOBAL_UI_SCRIPT = """
<script id="global-world-class-ui-script">
document.addEventListener('DOMContentLoaded', () => {
  const errorHints = ['gagal', 'error', 'forbidden', 'invalid', 'tidak', 'wajib', 'expired'];
  const successHints = ['berhasil', 'sukses', 'success', 'tersimpan', 'diproses'];

  const classifyAlert = (text) => {
    const t = (text || '').trim().toLowerCase();
    if(!t){ return 'empty'; }
    if(errorHints.some(w => t.includes(w))){ return 'error'; }
    if(successHints.some(w => t.includes(w))){ return 'success'; }
    return 'neutral';
  };

  const applyAlertState = (el) => {
    if(!el){ return; }
    const state = classifyAlert(el.textContent || '');
    el.classList.add('ui-alert');
    el.classList.remove('error', 'success', 'is-empty');
    if(state === 'empty'){
      el.classList.add('is-empty');
      return;
    }
    if(state === 'error'){
      el.classList.add('error');
      return;
    }
    if(state === 'success'){
      el.classList.add('success');
    }
  };

  const statusEls = Array.from(document.querySelectorAll(
    '[id$="Msg"],[id$="msg"],[id$="Status"],[id$="status"],[id$="Err"],[id$="err"],[id$="Ok"],[id$="ok"]'
  ));
  statusEls.forEach((el) => {
    if(!el.hasAttribute('aria-live')) el.setAttribute('aria-live', 'polite');
    if(!el.hasAttribute('role')) el.setAttribute('role', 'status');
    applyAlertState(el);
    const obs = new MutationObserver(() => applyAlertState(el));
    obs.observe(el, { childList: true, subtree: true, characterData: true });
  });

  const controls = document.querySelectorAll('input, select, textarea');
  controls.forEach((el, idx) => {
    if(!el.id){
      el.id = 'f_auto_' + idx;
    }
    if(
      !el.classList.contains('ui-field') &&
      !['hidden','checkbox','radio','file','submit','button'].includes((el.type || '').toLowerCase())
    ){
      el.classList.add('ui-field');
    }
    if(!el.getAttribute('aria-label')){
      const parentLabel = el.closest('label');
      if(parentLabel && parentLabel.textContent.trim()){
        el.setAttribute('aria-label', parentLabel.textContent.trim());
      }
    }
  });

  document.querySelectorAll('button, a[role="button"]').forEach((el) => {
    if(!el.classList.contains('ui-btn')){
      el.classList.add('ui-btn');
    }
  });
});
</script>
"""


def inject_world_class_ui(html: str) -> str:
    out = html or ""
    if "global-world-class-ui" not in out:
        if "</head>" in out:
            out = out.replace("</head>", GLOBAL_UI_STYLE + "\n</head>")
        else:
            out = GLOBAL_UI_STYLE + out
    if "global-world-class-ui-script" not in out:
        if "</body>" in out:
            out = out.replace("</body>", GLOBAL_UI_SCRIPT + "\n</body>")
        else:
            out = out + GLOBAL_UI_SCRIPT
    return out
