const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const moment = require('moment');
const mysql = require('mysql2');

require('dotenv').config();

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: 50948,                     // Porta do banco de dados
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    connectTimeout: 10000            // Timeout aumentado para 10 segundos
});

db.connect(err => {
    if (err) {
        console.error('Erro ao conectar ao banco de dados:', err);
    } else {
        console.log('✅ Conectado ao banco de dados!');
    }
});

const client = new Client({ authStrategy: new LocalAuth() });

client.on('qr', qr => {
    console.log('Escaneie o QR Code para conectar seu bot:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Bot do WhatsApp está pronto!');
});

// Autenticação com Google Calendar
const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/calendar']
});
const calendar = google.calendar({ version: 'v3', auth });

const clientes = {};

// Serviços disponíveis
const SERVICOS = {
    '1': 'Corte de cabelo',
    '2': 'Corte + barba',
    '3': 'Hidratação'
};

async function verificarHorariosDisponiveis(data) {
    try {
        const agora = moment();
        const dataEscolhida = moment(data, 'DD/MM/YYYY');

        const inicioDia = dataEscolhida.startOf('day').toISOString();
        const fimDia = dataEscolhida.endOf('day').toISOString();

        const eventos = await calendar.events.list({
            calendarId: process.env.CALENDAR_ID,
            timeMin: inicioDia,
            timeMax: fimDia,
            singleEvents: true,
            orderBy: 'startTime'
        });

        const horariosOcupados = eventos.data.items.map(evento => moment(evento.start.dateTime).format('HH:mm'));

        const horariosDisponiveis = [];
        for (let hora = 8; hora <= 18; hora++) {
            const horarioFormatado = moment().set({ hour: hora, minute: 0 }).format('HH:mm');

            const dataHoraEscolhida = moment(`${dataEscolhida.format('DD/MM/YYYY')} ${horarioFormatado}`, 'DD/MM/YYYY HH:mm');
            if (dataEscolhida.isSame(agora, 'day') && dataHoraEscolhida.isBefore(agora, 'minute')) {
                continue;
            }

            if (!horariosOcupados.includes(horarioFormatado)) {
                horariosDisponiveis.push(horarioFormatado);
            }
        }

        return horariosDisponiveis;
    } catch (error) {
        console.error('Erro ao verificar horários disponíveis:', error);
        return [];
    }
}

async function cancelarAgendamento(eventId) {
    try {
        await calendar.events.delete({
            calendarId: process.env.CALENDAR_ID,
            eventId: eventId
        });

        // Atualiza o status no banco de dados
        const query = 'UPDATE tb_whatsAgenda SET status = ? WHERE event_id = ?';
        await db.execute(query, ['cancelado', eventId]);

        return true;
    } catch (error) {
        console.error('Erro ao cancelar agendamento:', error.response ? error.response.data : error.message);
        return false;
    }
}

async function buscarAgendamentosPorCPF(cpf) {
    try {
        const agora = new Date().toISOString();
        const eventos = await calendar.events.list({
            calendarId: process.env.CALENDAR_ID,
            timeMin: agora,
            singleEvents: true,
            orderBy: 'startTime'
        });

        return eventos.data.items.filter(evento => evento.description && evento.description.includes(cpf));
    } catch (error) {
        console.error('Erro ao buscar agendamentos:', error);
        return [];
    }
}

async function criarAgendamento(nome, cpf, servico, data, hora) {
    try {
        const dataHora = moment(`${data} ${hora}`, 'DD/MM/YYYY HH:mm').toISOString();

        const evento = {
            summary: `Agendamento - ${nome}`,
            description: `Cliente: ${nome}\nCPF: ${cpf}\nServiço: ${servico}`,
            start: { dateTime: dataHora, timeZone: 'America/Sao_Paulo' },
            end: { dateTime: moment(dataHora).add(1, 'hours').toISOString(), timeZone: 'America/Sao_Paulo' }
        };

        const response = await calendar.events.insert({
            calendarId: process.env.CALENDAR_ID,
            resource: evento
        });

        if (response.data.id) {
            const sql = `INSERT INTO tb_whatsAgenda (nome, cpf, servico, data, hora, event_id) VALUES (?, ?, ?, ?, ?, ?)`;
            const valores = [nome, cpf, servico, moment(data, 'DD/MM/YYYY').format('YYYY-MM-DD'), hora, response.data.id];

            db.query(sql, valores, (err, result) => {
                if (err) {
                    console.error('❌ Erro ao salvar no banco:', err);
                } else {
                    console.log('✅ Agendamento salvo no banco com ID:', result.insertId);
                }
            });
        }

        return response.data;
    } catch (error) {
        console.error('Erro ao criar agendamento:', error);
        return null;
    }
}


client.on('message', async message => {
    const msg = message.body.trim();
    const numeroCliente = message.from;

    if (!clientes[numeroCliente]) {
        clientes[numeroCliente] = { etapa: 'boasVindas' };
        return message.reply('👋 Olá! Qual é o seu nome?');
    }

    const cliente = clientes[numeroCliente];

    if (cliente.etapa === 'boasVindas') {
        cliente.nome = msg;
        cliente.etapa = 'pedirCPF';
        return message.reply('🔢 Informe seu CPF (apenas números):');
    }

    if (cliente.etapa === 'pedirCPF') {
        if (!/^[0-9]{11}$/.test(msg)) {
            return message.reply('❌ CPF inválido! Digite apenas os 11 números.');
        }
        cliente.cpf = msg;
        cliente.etapa = 'menuPrincipal';
        return message.reply(`🎉 Olá, *${cliente.nome}*! Como posso te ajudar?
1️⃣ *Agendar um horário*
2️⃣ *Cancelar um agendamento*`);
    }

    if (cliente.etapa === 'menuPrincipal') {
        if (msg === '1') {
            cliente.etapa = 'escolherServico';
            return message.reply(`✂️ Escolha o serviço desejado:
1️⃣ Corte de cabelo
2️⃣ Corte + barba
3️⃣ Hidratação

Digite o número correspondente ao serviço:`);
        }
        if (msg === '2') {
            cliente.etapa = 'listarAgendamentos';
            const agendamentos = await buscarAgendamentosPorCPF(cliente.cpf);
            if (agendamentos.length === 0) {
                delete clientes[numeroCliente];
                return message.reply('❌ Nenhum agendamento encontrado para esse CPF.');
            }
            cliente.agendamentos = agendamentos;
            let lista = agendamentos.map((e, i) => `${i + 1}️⃣ ${moment(e.start.dateTime).format('DD/MM/YYYY HH:mm')} - ${e.description.split('\n')[2]}`).join('\n');
            return message.reply(`📋 Seus agendamentos:
${lista}

Digite o número do agendamento que deseja cancelar.`);
        }
    }

    if (cliente.etapa === 'escolherServico') {
        if (!['1', '2', '3'].includes(msg)) {
            return message.reply('❌ Opção inválida! Digite 1, 2 ou 3 para escolher o serviço.');
        }
        cliente.servico = SERVICOS[msg];
        cliente.etapa = 'escolherData';
        return message.reply('📅 Informe a data desejada (DD/MM/YYYY):');
    }

    if (cliente.etapa === 'listarAgendamentos') {
        const index = parseInt(msg) - 1;

        if (isNaN(index) || index < 0 || index >= cliente.agendamentos.length) {
            return message.reply('❌ Número inválido. Tente novamente.');
        }

        cliente.agendamentoSelecionado = cliente.agendamentos[index].id;
        cliente.etapa = 'confirmarCancelamento';

        return message.reply(`❗ Tem certeza que deseja cancelar este agendamento?
📅 ${moment(cliente.agendamentos[index].start.dateTime).format('DD/MM/YYYY HH:mm')}
💈 ${cliente.agendamentos[index].description.split('\n')[2]}
Digite *SIM* para confirmar ou *NÃO* para voltar.`);
    }

    if (cliente.etapa === 'confirmarCancelamento') {
        if (msg.toLowerCase() === 'sim') {
            const sucesso = await cancelarAgendamento(cliente.agendamentoSelecionado);
            delete clientes[numeroCliente];

            return message.reply(sucesso ? '✅ Agendamento cancelado com sucesso!' : '❌ Erro ao cancelar.');
        } else {
            delete clientes[numeroCliente];
            return message.reply('❌ Cancelamento abortado.');
        }
    }

    if (cliente.etapa === 'escolherData') {
        if (!moment(msg, 'DD/MM/YYYY', true).isValid()) {
            return message.reply('❌ Data inválida! Digite no formato DD/MM/YYYY.');
        }

        const dataEscolhida = moment(msg, 'DD/MM/YYYY');
        const dataAtual = moment().startOf('day');

        if (dataEscolhida.isBefore(dataAtual)) {
            return message.reply('❌ Data inválida! Você não pode agendar um horario passado !! Informe outra data no formato DD/MM/YYYY.');
        }

        cliente.data = msg;

        const horariosDisponiveis = await verificarHorariosDisponiveis(cliente.data);

        if (horariosDisponiveis.length === 0) {
            return message.reply('❌ Não há horários disponíveis para esta data.');
        }

        cliente.horariosDisponiveis = horariosDisponiveis;
        cliente.etapa = 'escolherHora';

        return message.reply(`⏰ Os horários disponíveis para o dia ${cliente.data} são:
${horariosDisponiveis.join('\n')}

Escolha o horário desejado (HH:mm):`);
    }

    if (cliente.etapa === 'escolherHora') {
        if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(msg)) {
            return message.reply('❌ Horário inválido! Digite no formato HH:mm.');
        }

        if (!cliente.horariosDisponiveis.includes(msg)) {
            return message.reply('❌ Esse horário não está disponível. Escolha um dos horários da lista.');
        }

        cliente.hora = msg;
        cliente.etapa = 'confirmarAgendamento';

        return message.reply(`✅ Confirme seu agendamento:
👤 Cliente: ${cliente.nome}
💈 Serviço: ${cliente.servico}
📅 Data: ${cliente.data}
⏰ Horário: ${cliente.hora}

Digite *SIM* para confirmar ou *NÃO* para cancelar.`);
    }

    if (cliente.etapa === 'confirmarAgendamento') {
        if (msg.toLowerCase() === 'sim') {
            const agendamento = await criarAgendamento(cliente.nome, cliente.cpf, cliente.servico, cliente.data, cliente.hora);

            if (agendamento) {
                const mensagemConfirmacao = `✅ Agendamento realizado!  
👤 Cliente: ${cliente.nome}
💈 Serviço: ${cliente.servico}
📅 Data: ${cliente.data}
🕒 Hora: ${cliente.hora}`;
                
                delete clientes[numeroCliente];
                return message.reply(mensagemConfirmacao);
            } else {
                return message.reply('❌ Ocorreu um erro ao realizar o agendamento.');
            }
        } else {
            delete clientes[numeroCliente];
            return message.reply('❌ Agendamento cancelado.');
        }
    }
});

client.initialize();