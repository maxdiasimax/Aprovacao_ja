const dbAsync = require('./db_async');
const db = require('./database');

async function testInsert() {
    console.log("Iniciando teste de inserção...");
    
    // Aguardar inicialização (pooling)
    await new Promise(r => setTimeout(r, 1000));

    try {
        const pergunta = "Teste de Importação " + new Date().toISOString();
        const tipo = 'MultiplaEscolha';
        const opcoes = { A: 'Op1', B: 'Op2', C: '', D: '', E: '' };
        
        console.log("Tentando inserir...");
        await dbAsync.run(`INSERT INTO questoes (pergunta, resposta_detalhada, disciplina, banca, ano, tipo, opcoes_json, resposta_correta) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    pergunta, 
                    'Explicação Teste', 
                    'Disciplina Teste', 
                    'Banca Teste', 
                    2024, 
                    tipo, 
                    JSON.stringify(opcoes), 
                    'A'
                ]
        );
        console.log("Inserção SUCESSO!");
    } catch (err) {
        console.error("Inserção falhou:", err);
    }
    
    // Teste com campos nulos/vazios
    try {
        console.log("Tentando inserir com vazios...");
        await dbAsync.run(`INSERT INTO questoes (pergunta, resposta_detalhada, disciplina, banca, ano, tipo, opcoes_json, resposta_correta) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    "Teste Vazios " + Date.now(), 
                    "", 
                    "", 
                    "", 
                    2024, 
                    "CertoErrado", 
                    "{}", 
                    ""
                ]
        );
        console.log("Inserção Vazios SUCESSO!");
    } catch (err) {
        console.error("Inserção Vazios falhou:", err);
    }

    process.exit(0);
}

testInsert();
