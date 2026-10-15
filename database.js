require('dotenv').config();

let db;

if (process.env.DB_TYPE === 'mysql') {
    console.log("Conectando ao MySQL...");
    db = require('./database_mysql');
} else {
    console.log("Conectando ao SQLite...");
    const sqlite3 = require('sqlite3').verbose();
    const path = require('path');
    const dbPath = path.join(__dirname, 'aprovacao.db');
    
    db = new sqlite3.Database(dbPath);
    
    // Manter as migrações originais do SQLite aqui para fallback
    db.serialize(() => {
        // ... (Schema SQLite Original omitido para brevidade, mas o ideal seria mantê-lo ou extrair)
        // Por simplicidade, assumimos que quem usa SQLite já tem o DB ou usará o código legado.
        // Se for uma instalação nova SQLite, o código anterior deve ser preservado.
        
        // RE-INSERINDO SCHEMA SQLITE (Compactado)
        db.run(`CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            usuario TEXT UNIQUE NOT NULL,
            senha TEXT NOT NULL,
            perfil TEXT CHECK(perfil IN ('Admin', 'Aluno')) DEFAULT 'Aluno',
            telefone TEXT, status TEXT DEFAULT 'Ativo', vencimento DATE,
            email TEXT, data_cadastro DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS questoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pergunta TEXT NOT NULL, resposta_detalhada TEXT, disciplina TEXT, banca TEXT, ano INTEGER,
            tipo TEXT, opcoes_json TEXT, id_externo TEXT, resposta_correta TEXT
        )`);

        // Migração SQLite column check
        db.all("PRAGMA table_info(questoes)", (err, columns) => {
            if (!err && !columns.some(c => c.name === 'resposta_correta')) {
                db.run("ALTER TABLE questoes ADD COLUMN resposta_correta TEXT");
            }
        });

        db.run(`CREATE TABLE IF NOT EXISTS progresso (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER, questao_id INTEGER, status TEXT DEFAULT 'Novo',
            contagem_acertos INTEGER DEFAULT 0, ultima_revisao DATETIME, proxima_revisao DATETIME,
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id), FOREIGN KEY (questao_id) REFERENCES questoes(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS simulados (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER, data DATETIME DEFAULT CURRENT_TIMESTAMP, disciplina TEXT, banca TEXT,
            total_questoes INTEGER, acertos INTEGER, tempo_total INTEGER, tempo_gasto INTEGER, questoes_json TEXT,
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
        )`);

        ['param_disciplinas','param_bancas','param_instituicoes','param_cargos','param_anos',
         'param_carreiras','param_areas_formacao','param_escolaridades','param_dificuldades'
        ].forEach(t => db.run(`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL UNIQUE)`));
    });
}

// Inicializa Schema se necessário (MySQL faz isso no require, SQLite no serialize acima)
if (db.serialize) db.serialize();

module.exports = db;
