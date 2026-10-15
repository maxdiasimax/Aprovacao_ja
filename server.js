const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./database');
const dbAsync = require('./db_async');
const xlsx = require('xlsx');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Compatibilidade SQL: SQLite usa RANDOM(), MySQL usa RAND()
const DB_RANDOM = process.env.DB_TYPE === 'mysql' ? 'RAND()' : 'RANDOM()';

// Configurações
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: 'aprovacao-ja-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 horas
}));

// Mock Admin User Creation (if not exists)
db.get("SELECT * FROM usuarios WHERE usuario = 'admin'", (err, row) => {
    if (!row) {
        const hash = bcrypt.hashSync('admin123', 10);
        db.run("INSERT INTO usuarios (nome, usuario, senha, perfil, status) VALUES (?, ?, ?, ?, ?)", 
        ['Administrador', 'admin', hash, 'Admin', 'Ativo']);
    }
});

// Middleware de Segurança e Flash
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.query = req.query;
    
    if (req.session.user) {
        // Verificar status e validade
        db.get("SELECT status, vencimento FROM usuarios WHERE id = ?", [req.session.user.id], (err, user) => {
            if (err || !user || user.status !== 'Ativo' || (user.vencimento && new Date(user.vencimento) < new Date())) {
                req.session.destroy();
                return res.redirect('/login?error=expired');
            }
            next();
        });
    } else {
        const publicPaths = ['/login', '/css', '/js', '/imagens'];
        const isPublic = publicPaths.some(p => req.path.startsWith(p));
        if (isPublic) return next();
        res.redirect('/login');
    }
});

// Rotas de Autenticação
app.get('/login', (req, res) => {
    res.render('login', { error: req.query.error });
});

app.post('/login', (req, res) => {
    const { usuario, senha } = req.body;
    db.get("SELECT * FROM usuarios WHERE usuario = ?", [usuario], (err, user) => {
        if (user && bcrypt.compareSync(senha, user.senha)) {
            req.session.user = { id: user.id, nome: user.nome, usuario: user.usuario, perfil: user.perfil };
            res.redirect('/dashboard');
        } else {
            res.redirect('/login?error=invalid');
        }
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Dashboard
app.get('/dashboard', async (req, res) => {
    const userId = req.session.user.id;

    const queryStats = `
        SELECT 
            COUNT(*) as total,
            SUM(case when status = 'Acertado' then 1 else 0 end) as acertos
        FROM progresso WHERE usuario_id = ?
    `;

    const queryByDisciplina = `
        SELECT 
            q.disciplina,
            COUNT(*) as total,
            SUM(CASE WHEN p.status = 'Acertado' THEN 1 ELSE 0 END) as acertos
        FROM progresso p
        JOIN questoes q ON p.questao_id = q.id
        WHERE p.usuario_id = ?
        GROUP BY q.disciplina
    `;

    // Activity: simplified to count unique items reviewed per day based on last review date
    const queryActivity = `
        SELECT 
            substr(ultima_revisao, 1, 10) as data,
            COUNT(*) as count
        FROM progresso
        WHERE usuario_id = ? AND ultima_revisao IS NOT NULL
        GROUP BY substr(ultima_revisao, 1, 10)
        ORDER BY data DESC
        LIMIT 7
    `;

    try {
        const [stats, disciplinas, activity] = await Promise.all([
            dbAsync.get(queryStats, [userId]),
            dbAsync.all(queryByDisciplina, [userId]),
            dbAsync.all(queryActivity, [userId])
        ]);

        res.render('dashboard', { 
            stats: stats || { total: 0, acertos: 0 },
            disciplinas: disciplinas || [],
            activity: activity ? activity.reverse() : []
        });
    } catch (err) {
        console.error("Erro ao carregar dashboard:", err);
        res.render('dashboard', { 
            stats: { total: 0, acertos: 0 }, 
            disciplinas: [], 
            activity: [] 
        });
    }
});

// Redirecionamento da rota antiga
app.get('/estudo', (req, res) => {
    res.redirect('/flashcards');
});

// FlashCards (SRS)
app.get('/flashcards', (req, res) => {
    // Algoritmo SRS Prioridade:
    // 1. Revisar (proxima_revisao <= agora)
    // 2. Errei
    // 3. Novos (não estão no progresso)
    
    const userId = req.session.user.id;
    const query = `
        SELECT q.*, p.status as p_status FROM questoes q
        LEFT JOIN progresso p ON q.id = p.questao_id AND p.usuario_id = ?
        ORDER BY 
            CASE 
                WHEN p.status = 'Revisar' AND (p.proxima_revisao <= CURRENT_TIMESTAMP OR p.proxima_revisao IS NULL) THEN 1
                WHEN p.status = 'Errei' THEN 2
                WHEN p.status IS NULL OR p.status = 'Novo' THEN 3
                ELSE 4
            END,
            p.ultima_revisao ASC
        LIMIT 1
    `;

    db.get(query, [userId], (err, questao) => {
        if (err) {
            console.error("Erro ao buscar flashcard:", err);
            return res.status(500).send("Erro interno ao carregar flashcards");
        }
        if (!questao) return res.render('flashcards', { questao: null });
        
        try {
            questao.opcoes = questao.opcoes_json ? JSON.parse(questao.opcoes_json) : null;
            res.render('flashcards', { questao });
        } catch (e) {
            console.error("Erro ao fazer parse das opções:", e);
            res.render('flashcards', { questao: null, error: "Erro nos dados da questão" });
        }
    });
});

// Módulo de Questões (Prática Deliberada)
app.get('/questoes', async (req, res) => {
    const { disciplina, banca, ano } = req.query;
    let whereClause = "WHERE 1=1";
    let params = [];

    if (disciplina) {
        whereClause += " AND disciplina = ?";
        params.push(disciplina);
    }
    if (banca) {
        whereClause += " AND banca = ?";
        params.push(banca);
    }
    if (ano) {
        whereClause += " AND ano = ?";
        params.push(ano);
    }

    const queryQuestao = `SELECT * FROM questoes ${whereClause} ORDER BY ${DB_RANDOM} LIMIT 1`;

    try {
        const [disciplinas, bancas, anos, questao] = await Promise.all([
            dbAsync.all("SELECT nome as disciplina FROM param_disciplinas ORDER BY nome"),
            dbAsync.all("SELECT nome as banca FROM param_bancas ORDER BY nome"),
            dbAsync.all("SELECT nome as ano FROM param_anos ORDER BY nome DESC"),
            dbAsync.get(queryQuestao, params)
        ]);

        if (questao) {
            try {
                questao.opcoes = questao.opcoes_json ? JSON.parse(questao.opcoes_json) : null;
            } catch (e) {
                console.error("Erro ao fazer parse das opções da questão:", e);
            }
        }

        res.render('questoes_estudo', { 
            questao, 
            disciplinas: disciplinas || [], 
            bancas: bancas || [], 
            anos: anos || [],
            filtros: { disciplina, banca, ano }
        });
    } catch (err) {
        console.error("Erro ao carregar página de questões:", err);
        res.status(500).send("Erro interno ao carregar questões");
    }
});

app.post('/estudo/feedback', (req, res) => {
    const { questao_id, feedback } = req.body;
    const userId = req.session.user.id;
    
    // Feedback: 'Acertado', 'Errei', 'Revisar'
    db.get("SELECT * FROM progresso WHERE usuario_id = ? AND questao_id = ?", [userId, questao_id], (err, row) => {
        let nextReview = null;
        let acertos = row ? row.contagem_acertos : 0;

        if (feedback === 'Acertado') {
            acertos++;
            // Lógica simples de expiração: 1 dia, 3 dias, 7 dias...
            const days = Math.pow(2, acertos);
            nextReview = new Date();
            nextReview.setDate(nextReview.getDate() + days);
        } else if (feedback === 'Errei') {
            acertos = 0;
            nextReview = new Date(); // Imediato ou próxima carga
        } else {
            // Revisar
            nextReview = new Date();
            nextReview.setHours(nextReview.getHours() + 1); // 1 hora
        }

        if (row) {
            db.run("UPDATE progresso SET status = ?, contagem_acertos = ?, ultima_revisao = CURRENT_TIMESTAMP, proxima_revisao = ? WHERE id = ?",
            [feedback, acertos, nextReview ? nextReview.toISOString() : null, row.id]);
        } else {
            db.run("INSERT INTO progresso (usuario_id, questao_id, status, contagem_acertos, ultima_revisao, proxima_revisao) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)",
            [userId, questao_id, feedback, acertos, nextReview ? nextReview.toISOString() : null]);
        }
        res.json({ success: true });
    });
});

// Admin: Gestão de Usuários
app.get('/admin/usuarios', (req, res) => {
    if (req.session.user.perfil !== 'Admin') return res.redirect('/dashboard');
    db.all("SELECT * FROM usuarios ORDER BY data_cadastro DESC", (err, users) => {
        res.render('admin_usuarios', { users, msg: req.query.msg });
    });
});

app.post('/admin/usuarios/novo', (req, res) => {
    const { nome, usuario, senha, perfil, email, telefone } = req.body;
    const hash = bcrypt.hashSync(senha, 10);
    const vencimento = new Date();
    vencimento.setDate(vencimento.getDate() + 30); // 30 dias

    db.run("INSERT INTO usuarios (nome, usuario, senha, perfil, email, telefone, vencimento, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'Ativo')",
    [nome, usuario, hash, perfil, email, telefone, vencimento.toISOString().split('T')[0]], (err) => {
        if (err) {
            console.error(err);
            return res.redirect('/admin/usuarios?msg=error');
        }
        res.redirect('/admin/usuarios?msg=save_success');
    });
});

app.post('/admin/usuarios/editar', (req, res) => {
    if (req.session.user.perfil !== 'Admin') return res.status(403).send('Acesso negado');
    const { id, nome, usuario, senha, perfil, telefone, status } = req.body;
    
    // Se senha fornecida, atualiza com hash. Caso contrário, mantém.
    if (senha && senha.trim() !== "") {
        const hash = bcrypt.hashSync(senha, 10);
        db.run("UPDATE usuarios SET nome = ?, usuario = ?, senha = ?, perfil = ?, telefone = ?, status = ? WHERE id = ?",
        [nome, usuario, hash, perfil, telefone, status, id], (err) => {
            if (err) return res.redirect('/admin/usuarios?msg=error');
            res.redirect('/admin/usuarios?msg=edit_success');
        });
    } else {
        db.run("UPDATE usuarios SET nome = ?, usuario = ?, perfil = ?, telefone = ?, status = ? WHERE id = ?",
        [nome, usuario, perfil, telefone, status, id], (err) => {
            if (err) return res.redirect('/admin/usuarios?msg=error');
            res.redirect('/admin/usuarios?msg=edit_success');
        });
    }
});

app.post('/admin/usuarios/inativar/:id', (req, res) => {
    if (req.session.user.perfil !== 'Admin') return res.status(403).send('Acesso negado');
    db.run("UPDATE usuarios SET status = 'Inativo' WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.redirect('/admin/usuarios?msg=error');
        res.redirect('/admin/usuarios?msg=inactive_success');
    });
});

// Admin: Importação via Excel
const upload = multer({ dest: 'uploads/' });

app.get('/admin/questoes', async (req, res) => {
    if (req.session.user.perfil !== 'Admin') return res.redirect('/dashboard');
    
    // Paginação
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    try {
        const [totalResult, questoes, disciplinas, bancas] = await Promise.all([
            dbAsync.get("SELECT COUNT(*) as count FROM questoes"),
            dbAsync.all("SELECT * FROM questoes ORDER BY id DESC LIMIT ? OFFSET ?", [limit, offset]),
            dbAsync.all("SELECT nome FROM param_disciplinas ORDER BY nome"),
            dbAsync.all("SELECT nome FROM param_bancas ORDER BY nome")
        ]);

        const totalItems = totalResult.count;
        const totalPages = Math.ceil(totalItems / limit);

        res.render('admin_questoes', { 
            questoes: questoes || [],
            disciplinas: disciplinas || [],
            bancas: bancas || [],
            currentPage: page,
            totalPages: totalPages,
            limit: limit,
            totalItems: totalItems,
            query: req.query // Passar query params para exibir mensagens
        });
    } catch (err) {
        console.error("Erro ao carregar admin questoes:", err);
        res.status(500).send("Erro ao carregar painel de questões");
    }
});

app.post('/admin/questoes/importar', upload.single('planilha'), async (req, res) => {
    try {
        require('fs').appendFileSync('import_trace.log', `[${new Date().toISOString()}] Iniciando importação. File: ${req.file ? 'OK' : 'MISSING'}\n`);
    } catch(e) {}

    if (!req.file) return res.redirect('/admin/questoes?msg=error');

    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        let imported = 0;
        let duplicates = 0;

        for (const row of data) {
            const pergunta = row.Questão || row.Questao || row.pergunta; // Flexibilidade nome coluna
            if (!pergunta) continue;

            // Verificar duplicidade
            const existing = await dbAsync.get("SELECT id FROM questoes WHERE pergunta = ?", [pergunta]);
            
            if (existing) {
                duplicates++;
                continue;
            }

            let tipo = 'MultiplaEscolha'; // Default
            let opcoes = {};
            
            // Tratamento da Resposta Correta
            let rawResp = row.respostaCorreta || row.RespostaCorreta || row['Resposta Correta'] || row['resposta correta'];
            
            // Busca flexível/case-insensitive se ainda não encontrado
            if (!rawResp) {
                const key = Object.keys(row).find(k => k.toLowerCase().replace(/\s/g, '') === 'respostacorreta');
                if (key) rawResp = row[key];
            }

            let respostaCorreta = String(rawResp || '').trim();

            // Mapeamento de Certo/Errado para padrão se necessário (mas o sistema aceita 'Certo'/'Errado' ou valores diretos)
            // Se for múltipla escolha apenas a letra (A-E)
            // Se for C/E, esperamos 'Certo' ou 'Errado' (ou 'C'/'E')
            
            if (respostaCorreta.length === 1) respostaCorreta = respostaCorreta.toUpperCase();
            if (respostaCorreta.toLowerCase() === 'c' || respostaCorreta.toLowerCase() === 'certo') respostaCorreta = 'Certo';
            if (respostaCorreta.toLowerCase() === 'e' || respostaCorreta.toLowerCase() === 'errado') respostaCorreta = 'Errado';

            // Leitura explícita do Tipo
            let rawTipo = row['Tipo de Questão'] || row['tipo'] || row['Tipo'];
            if (rawTipo) {
                rawTipo = String(rawTipo).toLowerCase().replace(/\s/g, '').replace(/\//g, ''); // "Múltipla Escolha" -> "multiplaescolha"
                if (rawTipo.includes('multipla')) tipo = 'MultiplaEscolha';
                else if (rawTipo.includes('certo') || rawTipo.includes('errado')) tipo = 'CertoErrado';
                else if (rawTipo.includes('flash')) tipo = 'Flashcard';
            }

            // Detectar tipo pelo formato das colunas (apenas se nao definido via coluna Tipo)
            if (!rawTipo && (row.Certo || row.Errado || (row.A === undefined && row.opcaoA === undefined))) {
                // Heurística simples: se tem colunas Certo/Errado ou não tem A/opcaoA, pode ser C/E
                if (row.Certo || row.Errado) {
                    tipo = 'CertoErrado';
                    opcoes = { Certo: row.Certo || 'Certo', Errado: row.Errado || 'Errado' };
                } else if (row.opcaoA || row.A) {
                     // Recai no Multipla Escolha
                }
            }

            // Configurar opcoes baseadas no tipo final
            if (tipo === 'MultiplaEscolha') {
                 opcoes = { 
                    A: row.opcaoA || row.A || '', 
                    B: row.opcaoB || row.B || '', 
                    C: row.opcaoC || row.C || '', 
                    D: row.opcaoD || row.D || '', 
                    E: row.opcaoE || row.E || '' 
                };
            } else if (tipo === 'CertoErrado' && Object.keys(opcoes).length === 0) {
                 opcoes = { Certo: row.Certo || 'Certo', Errado: row.Errado || 'Errado' };
            } else if (tipo === 'Flashcard') {
                 opcoes = {}; // Flashcard não tem opcoes no JSON, usa resposta_detalhada
            }

            let disciplina = String(row.Matéria || row.Materia || row.disciplina || '').substring(0, 255);
            let banca = String(row.Banca || row.banca || '').substring(0, 255);
            let ano = parseInt(row.Ano || row.ano || new Date().getFullYear()) || new Date().getFullYear();

            // Auto-registro de Parâmetros (Banca e Disciplina)
            if (disciplina) await dbAsync.run("INSERT IGNORE INTO param_disciplinas (nome) VALUES (?)", [disciplina]);
            if (banca) await dbAsync.run("INSERT IGNORE INTO param_bancas (nome) VALUES (?)", [banca]);

            await dbAsync.run(`INSERT INTO questoes (pergunta, resposta_detalhada, disciplina, banca, ano, tipo, opcoes_json, resposta_correta) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    pergunta, 
                    row.Explicação || row.Explicacao || '', 
                    disciplina, 
                    banca, 
                    ano, 
                    tipo, 
                    JSON.stringify(opcoes), 
                    respostaCorreta
                ]
            );
            imported++;
        }

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        
        // Redireciona com resumo
        res.redirect(`/admin/questoes?msg=import_summary&imported=${imported}&skipped=${duplicates}`);

    } catch (err) {
        console.error("Erro na importação:", err);
        // DEBUG: Gravar erro em arquivo para análise
        try {
            const errorLog = {
                message: err.message,
                code: err.code,
                sql: err.sql,
                stack: err.stack
            };
            require('fs').writeFileSync('import_debug.log', JSON.stringify(errorLog, null, 2));
        } catch(e) { console.error("Falha ao gravar log de debug:", e); }

        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.redirect('/admin/questoes?msg=error');
    }
});

app.post('/admin/questoes/salvar', (req, res) => {
    if (req.session.user.perfil !== 'Admin') return res.status(403).send('Acesso negado');
    
    const { id, pergunta, resposta_detalhada, disciplina, banca, ano, tipo, opcoes, resposta_correta } = req.body;
    
    let opcoes_final = opcoes || {};
    let resp_correta_final = resposta_correta;

    // Se for flashcard, não temos opções
    if (tipo === 'Flashcard') {
        opcoes_final = {};
        resp_correta_final = ''; // Flashcard não tem letra de resposta
    }

    const opcoes_json = JSON.stringify(opcoes_final);

    if (id) {
        // Atualizar
        db.run(`UPDATE questoes SET pergunta = ?, resposta_detalhada = ?, disciplina = ?, banca = ?, ano = ?, tipo = ?, opcoes_json = ?, resposta_correta = ? WHERE id = ?`,
        [pergunta, resposta_detalhada, disciplina, banca, ano, tipo, opcoes_json, resposta_correta, id], (err) => {
            if (err) return res.status(500).send("Erro ao atualizar questão");
            res.redirect('/admin/questoes?msg=edit_success');
        });
    } else {
        // Criar
        db.run(`INSERT INTO questoes (pergunta, resposta_detalhada, disciplina, banca, ano, tipo, opcoes_json, resposta_correta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [pergunta, resposta_detalhada, disciplina, banca, ano, tipo, opcoes_json, resposta_correta], (err) => {
            if (err) {
                console.error("ERRO AO SALVAR QUESTÃO:", err);
                return res.status(500).send("Erro ao salvar questão: " + err.message);
            }
            res.redirect('/admin/questoes?msg=save_success');
        });
    }
});

app.post('/admin/questoes/excluir/:id', (req, res) => {
    if (req.session.user.perfil !== 'Admin') return res.status(403).send('Acesso negado');
    const { id } = req.params;
    db.run("DELETE FROM questoes WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).send("Erro ao excluir questão");
        res.redirect('/admin/questoes?msg=delete_success');
    });
});

// Admin: Parâmetros
app.get('/admin/parametros', (req, res) => {
    if (req.session.user.perfil !== 'Admin') return res.redirect('/dashboard');
    
    const tipo = req.query.tipo || 'disciplinas';
    const tabela = `param_${tipo}`;
    
    db.all(`SELECT * FROM ${tabela} ORDER BY nome ASC`, (err, itens) => {
        if (err) {
            console.error(err);
            return res.status(500).send("Erro ao carregar parâmetros");
        }
        res.render('admin_parametros', { itens, tipo });
    });
});

app.post('/admin/parametros/salvar', (req, res) => {
    if (req.session.user.perfil !== 'Admin') return res.status(403).send('Acesso negado');
    const { id, nome, tipo } = req.body;
    const tabela = `param_${tipo}`;

    if (id) {
        db.run(`UPDATE ${tabela} SET nome = ? WHERE id = ?`, [nome, id], (err) => {
            if (err) return res.status(500).send("Erro ao atualizar parâmetro");
            res.redirect(`/admin/parametros?tipo=${tipo}&msg=edit_success`);
        });
    } else {
        db.run(`INSERT INTO ${tabela} (nome) VALUES (?)`, [nome], (err) => {
            if (err) return res.status(500).send("Erro ao salvar parâmetro");
            res.redirect(`/admin/parametros?tipo=${tipo}&msg=save_success`);
        });
    }
});

app.post('/admin/parametros/excluir/:id', (req, res) => {
    if (req.session.user.perfil !== 'Admin') return res.status(403).send('Acesso negado');
    const { id } = req.params;
    const { tipo } = req.body;
    const tabela = `param_${tipo}`;

    db.run(`DELETE FROM ${tabela} WHERE id = ?`, [id], (err) => {
        if (err) return res.status(500).send("Erro ao excluir parâmetro");
        res.redirect(`/admin/parametros?tipo=${tipo}&msg=delete_success`);
    });
});

// Admin: Parâmetros - Template
app.get('/admin/parametros/template/:tipo', (req, res) => {
    if (req.session.user.perfil !== 'Admin') return res.status(403).send('Acesso negado');
    const { tipo } = req.params;
    
    const wb = xlsx.utils.book_new();
    const ws_data = [["Nome"]];
    const ws = xlsx.utils.aoa_to_sheet(ws_data);
    xlsx.utils.book_append_sheet(wb, ws, "Modelo");
    
    const fileName = `modelo_${tipo}.xlsx`;
    const filePath = path.join(__dirname, 'uploads', fileName);
    xlsx.writeFile(wb, filePath);
    
    res.download(filePath, fileName, (err) => {
        if (!err && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
});

// Admin: Parâmetros - Importar
app.post('/admin/parametros/importar', upload.single('planilha'), (req, res) => {
    if (req.session.user.perfil !== 'Admin') return res.status(403).send('Acesso negado');
    const { tipo } = req.body;
    const tabela = `param_${tipo}`;
    
    if (!req.file) return res.redirect(`/admin/parametros?tipo=${tipo}&msg=error`);

    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const importItem = (nome) => {
        return new Promise((resolve, reject) => {
            // MySQL syntax: INCERT IGNORE
            db.run(`INSERT IGNORE INTO ${tabela} (nome) VALUES (?)`, [nome], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    };

    Promise.all(data.map(row => row.Nome ? importItem(row.Nome) : Promise.resolve()))
        .then(() => {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.redirect(`/admin/parametros?tipo=${tipo}&msg=import_success`);
        })
        .catch(err => {
            console.error("Erro importação parâmetros:", err);
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.redirect(`/admin/parametros?tipo=${tipo}&msg=error`);
        });
});

// Fallback para GET na rota de importação
app.get('/admin/parametros/importar', (req, res) => {
    res.redirect('/admin/parametros');
});

// Módulo de Simulados
app.get('/simulados', async (req, res) => {
    try {
        const [disciplinas, bancas, historico] = await Promise.all([
            dbAsync.all("SELECT nome as disciplina FROM param_disciplinas ORDER BY nome"),
            dbAsync.all("SELECT nome as banca FROM param_bancas ORDER BY nome"),
            dbAsync.all("SELECT * FROM simulados WHERE usuario_id = ? ORDER BY data DESC LIMIT 10", [req.session.user.id])
        ]);

        res.render('simulados_config', { 
            disciplinas: disciplinas || [], 
            bancas: bancas || [],
            historico: historico || []
        });
    } catch (err) {
        console.error("Erro ao carregar simulados:", err);
        res.status(500).send("Erro ao carregar página de simulados");
    }
});

app.post('/simulados/iniciar', (req, res) => {
    const { disciplina, banca, qtd, tempo } = req.body;
    let whereClause = "WHERE 1=1";
    let params = [];

    if (disciplina) {
        whereClause += " AND disciplina = ?";
        params.push(disciplina);
    }
    if (banca) {
        whereClause += " AND banca = ?";
        params.push(banca);
    }

    const query = `SELECT * FROM questoes ${whereClause} ORDER BY ${DB_RANDOM} LIMIT ?`;
    params.push(parseInt(qtd));

    db.all(query, params, (err, questoes) => {
        if (err || !questoes || questoes.length === 0) {
            return res.redirect('/simulados?error=no_questions');
        }

        // Salvar sessão do simulado
        req.session.simulado = {
            questoes: questoes.map(q => {
                try {
                    q.opcoes = q.opcoes_json ? JSON.parse(q.opcoes_json) : null;
                } catch(e) {}
                return q;
            }),
            config: { disciplina, banca, qtd, tempo },
            respostas: {}, // id_questao: resposta
            inicio: new Date().toISOString()
        };

        res.redirect('/simulados/prova');
    });
});

app.get('/simulados/prova', (req, res) => {
    if (!req.session.simulado) return res.redirect('/simulados');
    res.render('simulados_prova', { simulado: req.session.simulado });
});

app.post('/simulados/finalizar', (req, res) => {
    if (!req.session.simulado) return res.json({ success: false });

    const { respostas, tempo_gasto } = req.body;
    const simulado = req.session.simulado;
    let acertos = 0;

    const resultados = simulado.questoes.map(q => {
        const respostaUser = respostas[q.id];
        const estaCorreta = (respostaUser === q.resposta_correta);
        if (estaCorreta) acertos++;
        return {
            id: q.id,
            pergunta: q.pergunta,
            resposta_correta: q.resposta_correta,
            resposta_user: respostaUser,
            correta: estaCorreta,
            explicacao: q.resposta_detalhada,
            opcoes: q.opcoes
        };
    });

    const dadosSimulado = [
        req.session.user.id,
        simulado.config.disciplina || 'Todas',
        simulado.config.banca || 'Todas',
        simulado.questoes.length,
        acertos,
        simulado.config.tempo,
        tempo_gasto,
        JSON.stringify(resultados)
    ];

    db.run(`INSERT INTO simulados (usuario_id, disciplina, banca, total_questoes, acertos, tempo_total, tempo_gasto, questoes_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, dadosSimulado, function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false });
        }
        const simuladoId = this.lastID;
        delete req.session.simulado;
        res.json({ success: true, id: simuladoId });
    });
});

app.get('/simulados/resultado/:id', (req, res) => {
    const { id } = req.params;
    db.get("SELECT * FROM simulados WHERE id = ? AND usuario_id = ?", [id, req.session.user.id], (err, row) => {
        if (!row) return res.redirect('/simulados');
        try {
            row.detalhes = JSON.parse(row.questoes_json);
        } catch(e) {
            row.detalhes = [];
        }
        res.render('simulados_resultado', { resultado: row });
    });
});

app.get('/create_template', (req, res) => {
    const generateTemplate = require('./create_template');
    const filePath = path.join(__dirname, 'template_questoes.xlsx');
    generateTemplate(filePath);
    res.download(filePath);
});

app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});
