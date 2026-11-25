require('dotenv').config();
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { gerarXlsx } = require('./xlsx');

const {
  PORT = 3000, JWT_SECRET,
  DB_HOST = 'localhost', DB_PORT = 3306, DB_USER = 'root', DB_PASS = '', DB_NAME = 'escala_bombeiros',
} = process.env;
const META = Number(process.env.META_POR_TURNO) || 6;        // vagas ideais por turno (escala do mapa de calor)
const APROVACAO_H = Number(process.env.APROVACAO_H) || 24;   // abaixo disso, excluir precisa de aprovação do chefe
const MAX_DIAS = Number(process.env.MAX_DIAS_MARCACAO) || 30; // só dá para marcar até X dias à frente
const MES_INICIAL = process.env.MES_INICIAL || '2026-11';    // ninguém navega para meses anteriores a este

if (!JWT_SECRET) { console.error('Defina JWT_SECRET no arquivo .env'); process.exit(1); }

const db = mysql.createPool({
  host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, database: DB_NAME,
  dateStrings: true, waitForConnections: true, connectionLimit: 10,
});

const HORA_INICIO = { MANHA: 7, TARDE: 13, NOITE: 19 };
const CNH_VALIDAS = ['A', 'B', 'C', 'D', 'E'];

const inicioDoTurno = (data, turno) =>
  new Date(`${data}T${String(HORA_INICIO[turno]).padStart(2, '0')}:00:00-03:00`);
const mesValido = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s) && s >= MES_INICIAL;
const dataValida = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && s.slice(0, 7) >= MES_INICIAL;
const dentroDoLimite = (data, turno, agora = new Date()) => inicioDoTurno(data, turno) - agora <= MAX_DIAS * 24 * 3600 * 1000;
// Turnos seguidos: manhã+tarde, tarde+noite e noite+manhã do dia seguinte. Cada turno vira um número na linha do tempo.
const IDX_TURNO = { MANHA: 0, TARDE: 1, NOITE: 2 };
const slot = (data, turno) => Math.floor(Date.parse(`${data}T00:00:00Z`) / 86400000) * 3 + IDX_TURNO[turno];
const MSG_SEGUIDO = 'Você já está marcado em um turno vizinho. Não é permitido marcar turnos seguidos (manhã e tarde, tarde e noite, ou noite e a manhã seguinte).';
async function temTurnoVizinho(usuarioId, data, turno) {
  const [rows] = await db.query(
    'SELECT data, turno FROM marcacoes WHERE usuario_id = ? AND data BETWEEN DATE_SUB(?, INTERVAL 1 DAY) AND DATE_ADD(?, INTERVAL 1 DAY)',
    [usuarioId, data, data]);
  const s = slot(data, turno);
  return rows.some((r) => Math.abs(slot(r.data, r.turno) - s) === 1);
}
const soDigitos = (t) => String(t).replace(/\D/g, '');
const fmtTel = (d) => (d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : d);
const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const ehGestor = (u) => u.perfil === 'admin' || u.perfil === 'chefe';

const app = express();
app.use(express.json());
app.use(cookieParser());

// ---------- autenticação ----------
function emitirSessao(res, id) {
  const token = jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
}

// O perfil é lido do banco a cada requisição: mudar o perfil no banco vale na hora.
async function usuarioDaSessao(req) {
  const { id } = jwt.verify(req.cookies.token, JWT_SECRET);
  const [[u]] = await db.query('SELECT id, perfil FROM usuarios WHERE id = ? AND ativo = 1', [id]);
  if (!u) throw new Error('sessão inválida');
  return u;
}

async function exigirLogin(req, res, next) {
  try { req.user = await usuarioDaSessao(req); next(); }
  catch { res.status(401).json({ erro: 'Faça login para continuar.' }); }
}

function exigirGestor(req, res, next) {
  if (ehGestor(req.user)) return next();
  res.status(403).json({ erro: 'Acesso restrito ao chefe de equipe.' });
}

const rota = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  });

app.post('/api/cadastro', rota(async (req, res) => {
  const { nome_completo, usuario, email, telefone, senha, cnh = [], mostrar_telefone } = req.body;
  if (![nome_completo, usuario, email, telefone, senha].every((v) => typeof v === 'string' && v.trim()))
    return res.status(400).json({ erro: 'Preencha todos os campos.' });
  if (!/^[a-z0-9._-]{3,30}$/i.test(usuario))
    return res.status(400).json({ erro: 'Usuário: 3 a 30 caracteres (letras, números, ponto, hífen ou _).' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
  if (!/^[\d\s()+-]+$/.test(telefone)) return res.status(400).json({ erro: 'Telefone: use apenas números.' });
  const tel = soDigitos(telefone);
  if (tel.length < 10 || tel.length > 11) return res.status(400).json({ erro: 'Telefone: informe o DDD e o número (10 ou 11 dígitos).' });
  if (senha.length < 6) return res.status(400).json({ erro: 'A senha precisa ter ao menos 6 caracteres.' });

  const cnhSet = CNH_VALIDAS.filter((c) => Array.isArray(cnh) && cnh.includes(c)).join(',');
  const [[{ total }]] = await db.query('SELECT COUNT(*) AS total FROM usuarios');
  const perfil = total === 0 ? 'admin' : 'bombeiro'; // o primeiro cadastro vira administrador
  const hash = await bcrypt.hash(senha, 10);

  try {
    const [r] = await db.query(
      `INSERT INTO usuarios (nome_completo, usuario, email, telefone, mostrar_telefone, senha_hash, cnh, perfil)
       VALUES (?,?,?,?,?,?,?,?)`,
      [nome_completo.trim(), usuario.trim().toLowerCase(), email.trim().toLowerCase(), tel,
        mostrar_telefone ? 1 : 0, hash, cnhSet, perfil]
    );
    emitirSessao(res, r.insertId);
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Usuário ou e-mail já cadastrado.' });
    throw e;
  }
}));

app.post('/api/login', rota(async (req, res) => {
  const { login, senha } = req.body;
  if (!login || !senha) return res.status(400).json({ erro: 'Informe usuário e senha.' });
  const l = String(login).trim().toLowerCase();
  const [[u]] = await db.query('SELECT id, senha_hash, ativo FROM usuarios WHERE usuario = ? OR email = ?', [l, l]);
  if (!u || !u.ativo || !(await bcrypt.compare(senha, u.senha_hash)))
    return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
  emitirSessao(res, u.id);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.get('/api/me', exigirLogin, rota(async (req, res) => {
  const [[u]] = await db.query(
    'SELECT id, nome_completo, usuario, perfil, cnh FROM usuarios WHERE id = ?', [req.user.id]);
  const extra = { meta: META, aprovacao_h: APROVACAO_H, mes_inicial: MES_INICIAL, max_dias: MAX_DIAS };
  if (ehGestor(u)) {
    const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM pedidos_exclusao WHERE status = 'PENDENTE'");
    extra.pedidos_pendentes = n;
  }
  res.json({ ...u, ...extra });
}));

// ---------- mapa de calor ----------
app.get('/api/mapa', exigirLogin, rota(async (req, res) => {
  const { mes } = req.query;
  if (!mesValido(mes)) return res.status(400).json({ erro: `Mês indisponível (a partir de ${MES_INICIAL}).` });
  const inicio = `${mes}-01`;
  const [contagem] = await db.query(
    `SELECT data, turno, COUNT(*) AS total FROM marcacoes
      WHERE data >= ? AND data < DATE_ADD(?, INTERVAL 1 MONTH) GROUP BY data, turno`, [inicio, inicio]);
  const [minhas] = await db.query(
    `SELECT data, turno FROM marcacoes
      WHERE usuario_id = ? AND data >= ? AND data < DATE_ADD(?, INTERVAL 1 MONTH)`, [req.user.id, inicio, inicio]);
  const [pendentes] = await db.query(
    `SELECT data, turno FROM pedidos_exclusao
      WHERE usuario_id = ? AND status = 'PENDENTE' AND data >= ? AND data < DATE_ADD(?, INTERVAL 1 MONTH)`,
    [req.user.id, inicio, inicio]);
  res.json({ contagem, minhas, pendentes });
}));

// Telefone: gestores sempre veem; colegas só veem de quem autorizou no cadastro.
app.get('/api/dia', exigirLogin, rota(async (req, res) => {
  const { data } = req.query;
  if (!dataValida(data)) return res.status(400).json({ erro: 'Data inválida.' });
  const [rows] = await db.query(
    `SELECT m.turno, u.nome_completo, u.cnh,
            CASE WHEN ? = 1 OR u.mostrar_telefone = 1 THEN u.telefone ELSE NULL END AS telefone
       FROM marcacoes m JOIN usuarios u ON u.id = m.usuario_id
      WHERE m.data = ? ORDER BY u.nome_completo`, [ehGestor(req.user) ? 1 : 0, data]);
  res.json(rows);
}));

// ---------- marcações ----------
app.post('/api/marcacoes', exigirLogin, rota(async (req, res) => {
  const { data, turno } = req.body;
  if (!dataValida(data) || !HORA_INICIO[turno]) return res.status(400).json({ erro: 'Data ou turno inválido.' });
  if (inicioDoTurno(data, turno) <= new Date()) return res.status(400).json({ erro: 'Esse turno já começou.' });
  if (!dentroDoLimite(data, turno)) return res.status(400).json({ erro: `Só é possível marcar até ${MAX_DIAS} dias à frente.` });
  if (await temTurnoVizinho(req.user.id, data, turno)) return res.status(409).json({ erro: MSG_SEGUIDO });
  await db.query('INSERT IGNORE INTO marcacoes (usuario_id, data, turno) VALUES (?,?,?)', [req.user.id, data, turno]);
  res.status(201).json({ ok: true });
}));

app.delete('/api/marcacoes', exigirLogin, rota(async (req, res) => {
  const { data, turno } = req.query;
  if (!dataValida(data) || !HORA_INICIO[turno]) return res.status(400).json({ erro: 'Data ou turno inválido.' });
  const faltam = inicioDoTurno(data, turno) - new Date();
  if (faltam <= 0) return res.status(400).json({ erro: 'Esse turno já começou.' });
  if (faltam < APROVACAO_H * 3600 * 1000 && !ehGestor(req.user))
    return res.status(403).json({ erro: `Faltam menos de ${APROVACAO_H}h para o turno. Peça a exclusão ao chefe de equipe.` });
  await db.query('DELETE FROM marcacoes WHERE usuario_id = ? AND data = ? AND turno = ?', [req.user.id, data, turno]);
  res.json({ ok: true });
}));

// Recorrente: um dia da semana (0=domingo ... 6=sábado) em todo o mês, nos turnos escolhidos.
app.post('/api/marcacoes/recorrente', exigirLogin, rota(async (req, res) => {
  const { mes, dia_semana, turnos } = req.body;
  const dow = Number(dia_semana);
  if (!mesValido(mes) || !Number.isInteger(dow) || dow < 0 || dow > 6 ||
      !Array.isArray(turnos) || !turnos.length || !turnos.every((t) => HORA_INICIO[t]))
    return res.status(400).json({ erro: 'Informe mês, dia da semana e ao menos um turno.' });

  if ((turnos.includes('MANHA') && turnos.includes('TARDE')) || (turnos.includes('TARDE') && turnos.includes('NOITE')))
    return res.status(400).json({ erro: 'Escolha turnos que não sejam seguidos (manhã e tarde, ou tarde e noite).' });

  const [ano, m] = mes.split('-').map(Number);
  const [existentes] = await db.query(
    'SELECT data, turno FROM marcacoes WHERE usuario_id = ? AND data >= DATE_SUB(?, INTERVAL 1 DAY) AND data <= DATE_ADD(?, INTERVAL 1 MONTH)',
    [req.user.id, `${mes}-01`, `${mes}-01`]);
  const ocupados = new Set(existentes.map((r) => slot(r.data, r.turno)));
  const diasNoMes = new Date(Date.UTC(ano, m, 0)).getUTCDate();
  const agora = new Date();
  const linhas = [];
  let foraDoLimite = 0;
  let porTurnoSeguido = 0;
  for (let d = 1; d <= diasNoMes; d++) {
    if (new Date(Date.UTC(ano, m - 1, d)).getUTCDay() !== dow) continue;
    const data = `${mes}-${String(d).padStart(2, '0')}`;
    for (const t of turnos) {
      if (inicioDoTurno(data, t) <= agora) continue;
      if (!dentroDoLimite(data, t, agora)) { foraDoLimite++; continue; }
      const sl = slot(data, t);
      if (ocupados.has(sl - 1) || ocupados.has(sl + 1)) { porTurnoSeguido++; continue; }
      linhas.push([req.user.id, data, t]);
    }
  }
  if (!linhas.length) return res.status(400).json({ erro: `Não há datas livres com esses critérios (só dá para marcar até ${MAX_DIAS} dias à frente, sem turnos seguidos).` });
  const [r] = await db.query('INSERT IGNORE INTO marcacoes (usuario_id, data, turno) VALUES ?', [linhas]);
  res.status(201).json({ criadas: r.affectedRows, ja_existiam: linhas.length - r.affectedRows, fora_do_limite: foraDoLimite, por_turno_seguido: porTurnoSeguido });
}));

// ---------- pedidos de exclusão (< 24h do turno) ----------
app.post('/api/pedidos', exigirLogin, rota(async (req, res) => {
  const { data, turno } = req.body;
  if (!dataValida(data) || !HORA_INICIO[turno]) return res.status(400).json({ erro: 'Data ou turno inválido.' });
  const faltam = inicioDoTurno(data, turno) - new Date();
  if (faltam <= 0) return res.status(400).json({ erro: 'Esse turno já começou.' });
  if (faltam >= APROVACAO_H * 3600 * 1000)
    return res.status(400).json({ erro: 'Ainda dá tempo de desmarcar direto, sem pedido.' });
  const [[tem]] = await db.query('SELECT id FROM marcacoes WHERE usuario_id = ? AND data = ? AND turno = ?', [req.user.id, data, turno]);
  if (!tem) return res.status(404).json({ erro: 'Você não está marcado nesse turno.' });
  const [[ja]] = await db.query(
    "SELECT id FROM pedidos_exclusao WHERE usuario_id = ? AND data = ? AND turno = ? AND status = 'PENDENTE'", [req.user.id, data, turno]);
  if (ja) return res.status(409).json({ erro: 'Já existe um pedido aguardando o chefe.' });
  await db.query('INSERT INTO pedidos_exclusao (usuario_id, data, turno) VALUES (?,?,?)', [req.user.id, data, turno]);
  res.status(201).json({ ok: true });
}));

app.get('/api/pedidos', exigirLogin, exigirGestor, rota(async (req, res) => {
  const [rows] = await db.query(
    `SELECT p.id, p.data, p.turno, p.criado_em, u.nome_completo, u.usuario
       FROM pedidos_exclusao p JOIN usuarios u ON u.id = p.usuario_id
      WHERE p.status = 'PENDENTE' ORDER BY p.data, p.turno`);
  res.json(rows);
}));

app.post('/api/pedidos/:id/decidir', exigirLogin, exigirGestor, rota(async (req, res) => {
  const id = Number(req.params.id);
  const aprovar = req.body.aprovar === true;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query("SELECT * FROM pedidos_exclusao WHERE id = ? AND status = 'PENDENTE' FOR UPDATE", [id]);
    if (!p) { await conn.rollback(); return res.status(404).json({ erro: 'Pedido não encontrado ou já decidido.' }); }
    if (aprovar) await conn.query('DELETE FROM marcacoes WHERE usuario_id = ? AND data = ? AND turno = ?', [p.usuario_id, p.data, p.turno]);
    await conn.query('UPDATE pedidos_exclusao SET status = ?, decidido_por = ?, decidido_em = NOW() WHERE id = ?',
      [aprovar ? 'APROVADO' : 'RECUSADO', req.user.id, id]);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

// ---------- usuários (chefe e admin) ----------
app.get('/api/usuarios', exigirLogin, exigirGestor, rota(async (req, res) => {
  const [rows] = await db.query(
    `SELECT id, nome_completo, usuario, email, telefone, cnh, perfil, ativo, criado_em
       FROM usuarios ORDER BY nome_completo`);
  res.json(rows);
}));

app.post('/api/usuarios/:id/senha', exigirLogin, exigirGestor, rota(async (req, res) => {
  const { nova_senha } = req.body;
  if (typeof nova_senha !== 'string' || nova_senha.length < 6)
    return res.status(400).json({ erro: 'A nova senha precisa ter ao menos 6 caracteres.' });
  const [[alvo]] = await db.query('SELECT id, perfil FROM usuarios WHERE id = ?', [Number(req.params.id)]);
  if (!alvo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  if (alvo.perfil === 'admin' && req.user.perfil !== 'admin')
    return res.status(403).json({ erro: 'Só o administrador redefine a senha de outro administrador.' });
  await db.query('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [await bcrypt.hash(nova_senha, 10), alvo.id]);
  res.json({ ok: true });
}));

app.post('/api/usuarios', exigirLogin, exigirGestor, rota(async (req, res) => {
  const { nome_completo, usuario, email, telefone, senha, cnh = [], mostrar_telefone = false, perfil = 'bombeiro' } = req.body;

  if (![nome_completo, usuario, email, telefone, senha].every((v) => typeof v === 'string' && v.trim()))
    return res.status(400).json({ erro: 'Preencha todos os campos.' });
  if (!/^[a-z0-9._-]{3,30}$/i.test(usuario))
    return res.status(400).json({ erro: 'Usuário: 3 a 30 caracteres (letras, números, ponto, hífen ou _).' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
  const tel = soDigitos(telefone);
  if (tel.length < 10 || tel.length > 11) return res.status(400).json({ erro: 'Telefone: informe o DDD e o número (10 ou 11 dígitos).' });
  if (typeof senha !== 'string' || senha.length < 6) return res.status(400).json({ erro: 'A senha precisa ter ao menos 6 caracteres.' });

  if (!['bombeiro', 'chefe', 'admin'].includes(perfil))
    return res.status(400).json({ erro: 'Perfil inválido.' });
  if (req.user.perfil !== 'admin' && perfil !== 'bombeiro')
    return res.status(403).json({ erro: 'Apenas administradores podem criar chefes ou administradores.' });

  const cnhSet = CNH_VALIDAS.filter((c) => Array.isArray(cnh) && cnh.includes(c)).join(',');
  const hash = await bcrypt.hash(senha, 10);

  try {
    await db.query(
      `INSERT INTO usuarios (nome_completo, usuario, email, telefone, mostrar_telefone, senha_hash, cnh, perfil)
       VALUES (?,?,?,?,?,?,?,?)`,
      [nome_completo.trim(), usuario.trim().toLowerCase(), email.trim().toLowerCase(), tel,
        mostrar_telefone ? 1 : 0, hash, cnhSet, perfil]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Usuário ou e-mail já cadastrado.' });
    throw e;
  }
}));

// ---------- exportação para planilha (chefe e admin) ----------
function enviarXlsx(res, nome, buf) {
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${nome}"`,
  });
  res.send(buf);
}

app.get('/api/exportar/escala', exigirLogin, exigirGestor, rota(async (req, res) => {
  const { mes } = req.query;
  if (!mesValido(mes)) return res.status(400).json({ erro: `Mês indisponível (a partir de ${MES_INICIAL}).` });
  const [rows] = await db.query(
    `SELECT m.data, m.turno, u.nome_completo FROM marcacoes m JOIN usuarios u ON u.id = m.usuario_id
      WHERE m.data >= ? AND m.data < DATE_ADD(?, INTERVAL 1 MONTH) ORDER BY m.data, u.nome_completo`,
    [`${mes}-01`, `${mes}-01`]);
  const porDia = {};
  rows.forEach((r) => { ((porDia[r.data] ??= { MANHA: [], TARDE: [], NOITE: [] })[r.turno]).push(r.nome_completo); });
  const [ano, m] = mes.split('-').map(Number);
  const linhas = [];
  for (let d = 1; d <= new Date(Date.UTC(ano, m, 0)).getUTCDate(); d++) {
    const data = `${mes}-${String(d).padStart(2, '0')}`;
    const t = porDia[data] || { MANHA: [], TARDE: [], NOITE: [] };
    linhas.push([`${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${ano}`, DIAS_SEMANA[new Date(Date.UTC(ano, m - 1, d)).getUTCDay()],
      t.MANHA.join('; '), t.TARDE.join('; '), t.NOITE.join('; '), t.MANHA.length, t.TARDE.length, t.NOITE.length]);
  }
  const colunas = [
    { titulo: 'Data', largura: 12 }, { titulo: 'Dia da semana', largura: 15 },
    { titulo: 'Manhã (07h–13h)', largura: 38 }, { titulo: 'Tarde (13h–19h)', largura: 38 }, { titulo: 'Noite (19h–07h)', largura: 38 },
    { titulo: 'Qtd manhã', largura: 11 }, { titulo: 'Qtd tarde', largura: 11 }, { titulo: 'Qtd noite', largura: 11 },
  ];
  enviarXlsx(res, `escala-${mes}.xlsx`, gerarXlsx(`Escala ${mes}`, colunas, linhas));
}));

app.get('/api/exportar/usuarios', exigirLogin, exigirGestor, rota(async (req, res) => {
  const [rows] = await db.query(
    'SELECT nome_completo, usuario, email, telefone, cnh, perfil, ativo, criado_em FROM usuarios ORDER BY nome_completo');
  const PERFIL = { admin: 'Administrador', chefe: 'Chefe de equipe', bombeiro: 'Bombeiro' };
  const linhas = rows.map((u) => [u.nome_completo, u.usuario, u.email, fmtTel(u.telefone), u.cnh || 'Nenhuma', PERFIL[u.perfil], u.ativo ? 'Sim' : 'Não', u.criado_em]);
  const colunas = [
    { titulo: 'Nome completo', largura: 32 }, { titulo: 'Usuário', largura: 16 }, { titulo: 'E-mail', largura: 32 },
    { titulo: 'Telefone', largura: 16 }, { titulo: 'CNH', largura: 10 }, { titulo: 'Perfil', largura: 16 },
    { titulo: 'Ativo', largura: 8 }, { titulo: 'Cadastro', largura: 20 },
  ];
  enviarXlsx(res, 'usuarios.xlsx', gerarXlsx('Usuários', colunas, linhas));
}));

// ---------- páginas ----------
// A página de gestão só é entregue a chefe/admin; os demais voltam para a escala.
app.get('/gestao.html', async (req, res) => {
  try {
    if (ehGestor(await usuarioDaSessao(req))) return res.sendFile(path.join(__dirname, 'public', 'gestao.html'));
  } catch { /* cai no redirect */ }
  res.redirect('/app.html');
});
app.use(express.static(path.join(__dirname, 'public')));

db.query('SELECT 1')
  .then(() => app.listen(PORT, () => console.log(`Escala rodando em http://localhost:${PORT}`)))
  .catch((e) => { console.error('Falha ao conectar no MySQL:', e.message); process.exit(1); });
