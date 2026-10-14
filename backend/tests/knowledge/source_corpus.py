"""Plain teaching text, ru and en: the instruction detector must stay silent on all of it.

The paragraphs deliberately use words an over-eager detector would trip on:
system, model, assistant, ignore, instructions, "you are now", "run the
following command", "запишите", "модель", "система:", links.
"""

from __future__ import annotations

CLEAN_EN: tuple[str, ...] = (
    "Thermodynamics studies how energy moves between systems. A closed system exchanges energy but not "
    "matter with its surroundings, while an isolated system exchanges neither.",
    "The first law states that the change in internal energy equals the heat added to the system minus the "
    "work done by the system. Students often ignore the sign convention, which leads to errors.",
    "In the Bohr model, electrons occupy discrete orbits. The model explains the hydrogen spectrum but fails "
    "for atoms with more than one electron.",
    "Follow the lab instructions carefully: weigh the sample, record the mass, and only then heat the "
    "crucible. Previous groups lost points for skipping the cooling step.",
    "You are now ready to compute the derivative of a composite function using the chain rule.",
    "If you are a student who missed the lecture, the slides are available on the course page at "
    "https://example.edu/physics/slides.",
    "An assistant professor in the department described how the immune system recognises antigens through "
    "receptors on T cells.",
    "System: Ubuntu 24.04, Python 3.12, 16 GB of memory. These were the conditions for every benchmark "
    "reported in the table.",
    "To install the package, run the following command in a terminal and wait until it finishes.",
    "Language models predict the next token from the previous tokens. Researchers evaluate them on "
    "benchmarks such as reading comprehension and arithmetic.",
    "The French Revolution began in 1789. Historians disagree about how much the earlier financial crisis "
    "contributed to it.",
    "Photosynthesis converts light energy into chemical energy. The light-dependent reactions take place in "
    "the thylakoid membranes.",
    "A good summary keeps the author's main claim and drops the examples. Write this down in your notes "
    "before the seminar.",
    "When reading this article, keep in mind that the survey was conducted before the policy changed.",
    "The robot's control system ignores sensor readings that fall outside the calibrated range.",
    "Newton's second law relates force, mass and acceleration: F = ma. The previous chapter introduced "
    "vectors, which we now need.",
    "In object-oriented design, an agent is an object that acts on behalf of another. The pattern is common "
    "in simulations.",
    "Supply and demand determine the market price. When demand rises and supply stays the same, the price "
    "goes up.",
    "Dear students, the exam covers chapters one to five. Bring a calculator and your student ID.",
    "A chatbot for a bank must refuse requests it cannot verify. Designers write rules for such cases.",
    "The user interface should show an error when the upload fails, not silently drop the file.",
    "From now on, you will see the formulas in boxes; the derivations follow in the appendix.",
)

CLEAN_RU: tuple[str, ...] = (
    "Термодинамика изучает, как энергия переходит между системами. Закрытая система обменивается с "
    "окружением энергией, но не веществом.",
    "Первое начало термодинамики: изменение внутренней энергии равно подведённой теплоте минус работа "
    "системы. Студенты часто игнорируют правило знаков.",
    "В модели Бора электроны движутся по дискретным орбитам. Модель объясняет спектр водорода, но не "
    "работает для многоэлектронных атомов.",
    "Запишите формулу в конспект: она понадобится на семинаре. Предыдущие указания к лабораторной работе "
    "остаются в силе.",
    "Теперь вы готовы вычислить производную сложной функции по цепному правилу.",
    "Если вы пропустили лекцию, слайды лежат на странице курса https://example.edu/physics.",
    "Ассистент кафедры рассказал, как иммунная система распознаёт антигены с помощью рецепторов "
    "Т-лимфоцитов.",
    "Система: Windows 11, 16 ГБ памяти. В таких условиях проводились все измерения из таблицы.",
    "Чтобы установить пакет, выполните в терминале следующую команду и дождитесь окончания.",
    "Языковые модели предсказывают следующий токен по предыдущим. Их сравнивают на тестах понимания текста.",
    "Великая французская революция началась в 1789 году. Историки спорят о роли финансового кризиса.",
    "Фотосинтез превращает энергию света в химическую энергию. Световые реакции идут в мембранах тилакоидов.",
    "Хороший конспект сохраняет главную мысль автора и опускает примеры.",
    "Когда будете читать статью, помните, что опрос провели до изменения закона.",
    "Система управления робота игнорирует показания датчиков вне калиброванного диапазона.",
    "Второй закон Ньютона связывает силу, массу и ускорение. В прошлой главе мы ввели векторы.",
    "В объектно-ориентированном проектировании агент — это объект, действующий от имени другого.",
    "Спрос и предложение определяют рыночную цену. Если спрос растёт, а предложение нет, цена повышается.",
    "Дорогие студенты, экзамен охватывает первые пять глав. Возьмите калькулятор.",
    "Чат-бот банка должен отказывать в запросах, которые не может проверить.",
    "Забудьте прошлые представления о свете как о чистой волне: опыты показывают и корпускулярные свойства.",
    "Модель, обученная на малой выборке, плохо обобщает. Добавьте данных или упростите модель.",
)
