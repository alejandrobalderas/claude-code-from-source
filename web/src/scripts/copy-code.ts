// Add copy buttons to all code blocks
document.querySelectorAll('pre').forEach((pre) => {
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block-wrapper';
  pre.parentNode?.insertBefore(wrapper, pre);
  wrapper.appendChild(pre);

  const btn = document.createElement('button');
  btn.className = 'copy-button';
  btn.textContent = '복사';
  btn.addEventListener('click', async () => {
    const code = pre.querySelector('code')?.textContent || pre.textContent || '';
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = '복사됨!';
      setTimeout(() => { btn.textContent = '복사'; }, 2000);
    } catch {
      btn.textContent = '복사 실패';
      setTimeout(() => { btn.textContent = '복사'; }, 2000);
    }
  });
  wrapper.appendChild(btn);
});
