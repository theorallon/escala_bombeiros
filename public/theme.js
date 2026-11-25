(function () {
  const chave = 'escala-tema';
  const temaSalvo = localStorage.getItem(chave);
  const temaInicial = temaSalvo || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro');

  function aplicar(tema) {
    document.documentElement.dataset.theme = tema;
    localStorage.setItem(chave, tema);
    const botao = document.getElementById('tema-toggle');
    if (botao) {
      const escuro = tema === 'escuro';
      botao.setAttribute('aria-pressed', String(escuro));
      botao.setAttribute('aria-label', escuro ? 'Usar modo claro' : 'Usar modo escuro');
      botao.innerHTML = escuro ? '☀️ <span>Modo claro</span>' : '🌙 <span>Modo escuro</span>';
    }
  }

  aplicar(temaInicial);

  document.addEventListener('DOMContentLoaded', function () {
    if (document.getElementById('tema-toggle')) return;
    const botao = document.createElement('button');
    botao.id = 'tema-toggle';
    botao.className = 'tema-toggle';
    botao.type = 'button';
    botao.addEventListener('click', function () {
      aplicar(document.documentElement.dataset.theme === 'escuro' ? 'claro' : 'escuro');
    });
    document.body.appendChild(botao);
    aplicar(document.documentElement.dataset.theme);
  });
})();
