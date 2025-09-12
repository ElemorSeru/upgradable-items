<a href="https://www.patreon.com/c/Elemor/home"> <img src="https://img.shields.io/badge/Patreon-F96854?style=for-the-badge&logo=patreon&logoColor=white" /></a> &nbsp;&nbsp;
<!--<a href="https://gitlocalize.com/repo/10450?utm_source=badge"> <img src="https://gitlocalize.com/repo/10450/whole_project/badge.svg" /></a> -->
# Upgradable Item Slots
A Dnd5e **(Still WIP)** module for the Foundry VTT system that is an attempt at streamlining the item upgrade process for your players and yourself as the DM/GM. What this offers is a way to take an item, modify "slots" and give items perks and features rather than always having to create and item and manually adjust things which take time. The idea is inspired by dwarven runes being slotted into items and those runes giving perks, boons, and banes accordingly.

## History/Reasoning
My players regularly asked about upgrading their existing items, crafting new items, etc. I spent a fair amount of time coming up with quests, macros, and other concepts to develop special homebrewed items and most of the time I had to spend time in between sessions working through foundry's different features, integrating with other modules, creating macros, etc. This is a way of allowing the DM to have a simplified and semi-automated framework of upgrades to quickly "slot" in the features as they may wish. I've separated the homebrewed features into "Clusters" which indicate the environment the crafting or slotting would occur in to build an effect accordingly. This is thematic and to give the players more options (or limit them) according to the quests/etc which the DM/GM wishes to develop for this effort. 

The module also includes stat boosts that stack between all items and give an active effect to replicate temporary boons. In addition there are 2 additional options to add a spell and feature/feat to the actor which had the item equipped. These two sections work independant of the clusters and access your available compendium to generate the lists. Once selected, the spell or feature/feat is added to the actor and shows up in the character sheet. 

Most (if not nearly all) of these settings check that the item is equipped and/or if attunement is required. Once all these requirements are satisfied, the different settings activate/display/are gained. 

## Framework
Based on the item type (currently only for items that are of item type "equipment" and weapons that have melee(mwak)/ranged(rwak) typing), the item will include 4 new rune/cluster slots within the Details tab. Describing those first: 

<img width="500" height="1018" alt="image" src="https://github.com/ElemorSeru/upgradable-items/blob/main/images/itemSlotView.png" />

These indicate "Tiers" of upgrades. Consider them like slotting runes or magical items into the item. The Enhancment Level and Clusters work in conjunction, however not all Clusters use the Enhancment level (described below).

## Current (Goal) Mechanics
### 📈 Enhancement Level (Name/Armor/Weapon)
| Name | AC Gain | Weapon Die Roll | 
| --- | --- | --- |
| None | +0 | 0 |
| Runed | +1 | 1d4 | 
| Infused | +2 | 1d6 | 
| Awakened | +3 | 1d8 | 

### Terrain Themed Clusters
| Cluster | Environments | Elemental Themes | 
| --- | --- | --- |
| I | Coastal, Grassland, Savannah, Urban/City | Radiant, Thunder, Lightning | 
| II | Hills, Underground, Swamp, Desert, Forest | Acid, Necrotic, Earth | 
| III | Arctic, Feywild, Mountains, Volcanos, Blightshore | Fire, Cold, Volatile Magic | 


### 🔨 Tier 1 Cluster Effects
#### 🌀 Cluster I
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | Adds Radiant or thunder damage die to damage rolls according to enhancement level |
| Armor | Attacker takes lightning damage on successful attack equal to the enhancement die value |
| Ranged Weapon | On successful Dmg roll, Sonic attack causing target to have disadvantage on attacks for 1 round |

#### 🌿 Cluster II
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | Acid or necrotic damage die to damage rolls according to enhancement level |
| Armor | When falling prone and below half total HP, regain HP equal to enhancement die |
| Ranged Weapon | On successful Dmg roll, poison ammunition, target takes at start of each turn for 10 rounds or DC 13 Con save to save |

#### 🔥 Cluster III
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | Fire or cold damage die to damage rolls according to enhancement level |
| Armor | Falling below half HP, regain HP equal to enhancement die roll |
| Ranged Weapon | On successful Dmg roll, reduces target’s movement by 5 ft per enhancement die rolled value |


### 🔨 Tier 2 Cluster Effects
Tactical movement and terrain manipulation
Triggered on crits or once per short rest

#### 🌀 Cluster I
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | On successful crit Dmg roll, On DC13 Str, push target 10 ft |
| Armor | Grants passive ability to move through allies without provoking opportunity attacks as long as movement allows and and passing through an ally |
| Ranged Weapon | On successful crit Dmg roll, creates 10ft half cover for adjacent allies for 2 rounds |
  
#### 🌿 Cluster II
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | On successful crit Dmg roll, push 5ft + stagger target (half movement for 1 round) |
| Armor | Grants user the Mobile feat |
| Ranged Weapon | On successful Dmg roll, prevents Dash action for affected enemy for 1 round |

#### 🔥 Cluster III
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | On successfull Dmg roll, when target reaches 0hp, trigger area within 15ft of attacker to cause hostile creatures to lose reaction for 1 round |
| Armor | On successful hit, first melee attacker DC14 Con save or bonus action for 1 round |
| Ranged Weapon | On successful Dmg roll, target or empty space and 15ft around it reveal illusions/concealment/hiding creatures |


### 🛠️ Tier 3 Cluster Effects
Battlefield synergy, resilliance, boons
Must be forged in matching terrain. Usable once per long rest.

#### 🌀 Cluster I
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | On successful Crit Dmg roll, Allies within 20ft gain +2 to hit against target for 2 rounds |
| Armor | On melee successful attack recieved, Allies within 10ft gain +2 to AC for 2 rounds |
| Ranged Weapon | On successfull Crit Dmg roll, hostile creatures within 15ft of target or space are pulled 5ft closer to center of target |

#### 🌿 Cluster II
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | On Successful crit Dmg Roll, Target is restrained on DC15 Dex and takes necrotic damage equal to enhancement die |
| Armor | While in combat, Once per short rest, allies attacked within movement range allow the option to move to an adjacent square and trigger disadvantage on the attacker |
| Ranged Weapon | Create 15ft area of poison damage. DC14 Con save to not be poisoned. Cloud moves 5ft/round |

#### 🔥 Cluster III
| Item Type | Description | 
| --- | --- | 
| Melee Weapon | Create phantom illusion that gives advantage to the next attack when you successfully crit a creature|
| Armor | At 50% HP or lower, gain resistance to all damage until the end of next round. Hostile creatures within 10ft make DC15 Wis or become frightened |
| Ranged Weapon | Gain the Sharpshooter feat |

## Runic Stat Empowerment
<img width="500" alt="image" src="https://github.com/ElemorSeru/upgradable-items/blob/main/images/statBoons.png" />

Runic Stat Empowerment is meant to give boons to an actor and stack up to a maximum of 30 in said stat. These fields add a value to your base stat up to 10 per item. Multiple items with said bonus stack up to 30 and will downgrade according to the value reaching 30. Example being: If base STR stat is 27 and the user selects +10, the item's bonus STR enhancement will downgrade to +3 automatically.

## Additional Perks
<img width="500" alt="image" src="https://github.com/ElemorSeru/upgradable-items/blob/main/images/additionalPerks.png" />

Spell Enhancement and Feat Enhancment both read from the existing compendiums and list all the items you have access to. Once selected, the Spell or Feat/Feature will be added to the actor. Selecting a different Spell/Feat/Feature or defaulting back to the "Select a X" option will remove it. As mentioned before, these also only apply if the item is equipped and/or if attunement is gained for the item (if attunement is required). Unequipping will remove any added perks and equipping should re-add them. 

Additional perks and Clusters are independant of one another and an alternate method of giving your players Spells/Features quickly and dynamically. You may use both in combination as you wish. 

