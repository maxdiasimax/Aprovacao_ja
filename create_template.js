const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

function generateTemplate(outputPath) {
    const data = [
        {
            Banca: "FGV",
            Matéria: "Português",
            "Tipo de Questão": "Múltipla Escolha",
            Questão: "Qual o antônimo de 'Intrépido'?",
            opcaoA: "Corajoso",
            opcaoB: "Pusilânime",
            opcaoC: "Audaz",
            opcaoD: "Valente",
            opcaoE: "Medroso",
            RespostaCorreta: "B",
            Explicação: "Intrépido significa corajoso. Pusilânime é seu oposto (covarde)."
        },
        {
            Banca: "Cebraspe",
            Matéria: "Direito Adm",
            "Tipo de Questão": "Certo / Errado",
            Questão: "O ato administrativo discricionário não admite revogação por motivo de conveniência e oportunidade.",
            Certo: "Incorreto",
            Errado: "Correto",
            RespostaCorreta: "Certo",
            Explicação: "Atos discricionários PODEM ser revogados justamente por conveniência e oportunidade."
        }
    ];

    const ws = xlsx.utils.json_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, "Questoes");

    const filePath = outputPath || path.join(__dirname, 'template_questoes.xlsx');
    xlsx.writeFile(wb, filePath);
    console.log(`Template gerado em: ${filePath}`);
    return filePath;
}

if (require.main === module) {
    generateTemplate();
}

module.exports = generateTemplate;
