/*
 * Стартовый справочник Al Musk: закупочные цены за 1 мл масла, переданные владелицей 14.11.2026.
 * Загружается автоматически при первом запуске. Позже его можно дозагрузить
 * кнопкой в Справочнике: существующие цены при этом не перезаписываются без подтверждения.
 *
 * Уточнения при загрузке:
 *  - «Armani acqua di gio» и «D&G light blue» встречаются дважды с разной ценой
 *    (в женском и мужском блоках списка), поэтому записаны как две версии;
 *  - «Kenzo lear par ice 125» совпадает с «Kenzo leau par ice 125», записан один раз;
 *  - «Chanel splandide ?» и «LV pacific chill ?» без цены: себестоимость продаж
 *    этих ароматов будет ждать цены руководителя.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SEED = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DATE = '2026-11-14';
  const TEXT = `
Armani si passion 125
Armani my way 110
Armani acqua di gio (женский) 125
Armani prive pion 125
Bvlgari omnia crystal 125
Bvlgari omnia coral 125
Bvlgari omnia amethyst 125
Burberry her 90
Victoria secret bomb 125
Vs tease dreamer 125
Vs rich amber 125
Vs so sexy 90
Vs rose bergamot 90
Versace bright crystal 125
Versace versense 125
Zadig voltaire 70
Zarkop the muse 125
Hfc devils intrigue 110
Carolina her good girl 125
Carolina her 212 vip 125
D&G imperatric 125
D&G light blue (женский) 125
Dior blooming bouquet 125
Dior addict2 125
Dior jadore 125
Kilian dont be shy 125
Kilian good girl 125
Kilian playing devil 80
Gucci flora 100
Givenchy ange demon 125
Givenchy linterdit 125
Jo malone blackberry 200
Kenzo leau par 125
Kenzo leau par ice 125
Lanvin jeanne 125
Lanvin eclat 125
Lanvin modern princes 125
Lanvin rumeur rose2 125
Lacoste pour femme 125
Lancome la vie est belle 125
Lancome tresor mid night 125
Lancome idole 125
Moschino love love 125
Moschino funny 125
Montale vanila extasy 125
Montale roses elixir 125
Montale roses musk 125
Nina ricci premier jour 90
Nina ricci nina 125
Paco rabanne lady 125
Prada paradox 125
Chanel coco mademoiselle 170
Chanel splandide ?
Chanel tendre 125
Chanel fraiche 125
Trussardi donna 125
Frank oliver nature 80
Escada cherry 125
Escada moon sparkle 55
Chloe nomad 125
De marly delina roses 125
De marly valaya 150
Latafa eclaire 125
Latafa YARA 125
Ysl black opium 125
Ysl libre 125
Juliette not perfume 125
Mancera roses vanille 125
Mexx fly high 135
Britney spears 90
Amoage honor 90
Salvadore incanto 125
Creed carmina 260
Creed queen of silk 200
Armani acqua di gio (мужской) 145
Armani acqua profondo 115
Armani swy 125
Armani swy intensely 125
Antonio banderas blue 70
Bvlgari tyger 260
Bvlgari aqua marine 125
Versace fraiche 125
Versace eros 125
Versace pour homme 125
D&G light blue (мужской) 80
D&G K 125
Givenchy blue label 125
Givenchy fot men 125
Givenchy society 125
Jean paul le male elixir 125
Jean paul le beau 125
Creed aventus 125
Creed aventus absolu 125
LV imagination 320
LV limensite 260
Lacoste blanc 125
Mont blanc explorer 125
Paco rab invictus 12
Paco rab one million 125
Paco rab black xs lex 125
Roja elysium 320
Chanel blue 125
Chanel allure homme 80
Chanel egoist platinum 90
Ysl y 125
Capitan black 95
Davidof cool water 125
Hermess terre 80
Hugo boss bottel6 125
Ajmal blu 100
Clive chris blonde amber 250
De marly althair 260
Oriflame eclat sport 80
Carolina herrera chic 125
Carolina herrera 212 125
Arabian oud al fareed 245
Attar crystal love 120
Attar hayatti 120
Attar musk kashmir 125
Armani prive tanzanit 125
Armani prive malachite 125
Thomas kosmala4 165
Amoage guidance 125
Amoage outlands 200
Essential boise imperial 280
Byredo black shafron 125
Byredo blanche 90
Byredo marijuana 130
Byredo baldafrique 125
Byredo gipsy water 125
Byredo mojave ghost 170
Vilheim mango skin 125
Marc antone ganymed 250
Marc antone tilia 300
Hormon paris gaba 125
Ex nihillo blue talisman 125
Ex nihillo lust in paradise 125
Ex nihillo fleur narcotic 125
Jo malone nectarine 125
Jo malone sea salt 125
Zarkoper molecul 09 125
Zielinski black peper 125
Zielinski vanila blend 125
Escentric molecules1 125
Escentric molecules2 125
Initio oud for greatnes 170
Initio side effect 100
Initio narcotic delight 200
Initio rehab 70
Chopard vetiver 200
Kilian rolling love 125
Kilian black phantom 125
Kilian vodka 125
Kilian angel share 260
Kajal almaz 125
Kajal lamar 90
Kajal dahab 125
LV ombre nomad 125
LV afternoon swim 280
LV pacific chill ?
LV symphony 320
Hibiscus Mahajad 300
Oud maracuja 300
Mancera red tobacco 125
Mancera cedrat boise 140
Maison baccarat 540 180
Montale arabian tonka 220
Montale starry nights 125
Montale sweet vanilla 125
Montale sensual instinct 125
Montale intense cafe 125
Montale mukhalat 125
Montale chocolate 125
Nasomato black afgan 120
Richard white chocolate 110
Sospiro erba pura 125
Sospiro accento 240
Tiziana terenzi gumin 125
Tiziana terenzi kirke 125
Tiziana terenzi andromeda 125
Tiziana terenzi Cassiopeia 125
Tom ford tuskan leather 125
Tom ford tobacco vanilla 125
Tom ford fucking fabulous 125
Tom ford oud wood 125
Tom ford ombre leather 125
Tom ford lost cherry 125
Creed silver 125
Creed imperial 210
Creed oud zarian 190
Matsukita 300
Hedonistic 280
Orto paris megamare 125
Orto paris risvelium 220
Le labo another 13 320
Le labo santal 33 125
Ajmal amber wood 100
Arabian oud madawi 180
Al rehab soft 55
Al rehab madina 55
Musk al tahara 165
Feramon 250
Soblazn 90
Carisma 80
Ilmin orgasme 160
Shaikh 77 150
De marly sedlay 230
De marly layton 125
Borntostandout purple stain 190
`;
  return { DATE, TEXT };
});
