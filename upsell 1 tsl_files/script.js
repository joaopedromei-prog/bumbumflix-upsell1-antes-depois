// Ano dinâmico no rodapé
(function () {
  var el = document.getElementById('ano');
  if (el) el.textContent = new Date().getFullYear();
})();
