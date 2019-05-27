/**
 * Schedule handles the storage, access, mutation and render of courses and events.
 * @author Hanzhi Zhou, Kaiying Shan
 */
// tslint:disable: member-ordering

/**
 *
 */
import { colorDepthSearch, graphColoringExact } from '../algorithm/Coloring';
import { depthFirstSearch, Graph, Vertex } from '../algorithm/Graph';
import { RawAlgoSchedule } from '../algorithm/ScheduleGenerator';
import * as Utils from '../utils';
import Course from './Course';
import Event from './Event';
import Hashable from './Hashable';
import ScheduleBlock from './ScheduleBlock';
import Section from './Section';

export interface ScheduleJSON {
    All: { [x: string]: Array<{ id: number; section: string }> | number[] | -1 };
    title: string;
    id: number;
    events: Event[];
}

export interface ScheduleOptions {
    multiSelect: boolean;
    combineSections: boolean;
}

/**
 * A schedule is a list of courses with computed properties that aid rendering
 *
 * Note that `window.catalog` must be initialized before calling any instance method of the Schedule class
 */
export default class Schedule {
    public static readonly options: ScheduleOptions = Object.seal({
        combineSections: true,
        multiSelect: true
    });

    public static readonly bgColors: ReadonlyArray<string> = [
        '#f7867e',
        '#ffb74c',
        '#82677E',
        '#2C577C',
        '#6D838A',
        '#00a0a0',
        '#355dff',
        '#7790ff',
        '#9B5656',
        '#CC9393',
        '#993D5F'
    ];

    public static savedColors: { [x: string]: string } = {};

    public static isNumberArray(x: Array<any>): x is number[] {
        return typeof x[0] === 'number';
    }

    /**
     * instantiate a `Schedule` object from its JSON representation.
     * the `computeSchedule` method will be invoked
     */
    public static fromJSON(obj?: ScheduleJSON): Schedule | null {
        if (!obj) return null;
        const schedule = new Schedule();
        schedule.title = obj.title ? obj.title : 'schedule';
        schedule.id = obj.id ? obj.id : 0;
        if (obj.events)
            schedule.events = obj.events.map(x => Object.setPrototypeOf(x, Event.prototype));
        const keys = Object.keys(obj.All).map(x => x.toLowerCase());
        if (keys.length === 0) return schedule;

        const catalog = window.catalog;
        // convert array to set
        for (const key of keys) {
            const sections = obj.All[key];
            const course = catalog.getCourse(key);
            // non existent course
            if (course.isFake) {
                console.warn(key, 'does not exist anymore');
                continue;
            }
            const allSections = course.sections;
            if (sections instanceof Array) {
                if (!sections.length) {
                    schedule.All[key] = new Set();
                } else {
                    // backward compatibility for version prior to v5.0 (inclusive)
                    if (Schedule.isNumberArray(sections)) {
                        schedule.All[key] = new Set(
                            sections.filter(sid => {
                                // sid >= length possibly implies that section is removed from SIS
                                const isValid = sid < allSections.length;
                                if (!isValid) console.warn('invalid sec id', sid, 'for', key);
                                return sid < allSections.length;
                            })
                        );
                    } else {
                        const set = new Set<number>();
                        for (const record of sections) {
                            // check whether the identifier of stored sections match with the existing sections
                            const idx = allSections.findIndex(
                                sec => sec.id === record.id && sec.section === record.section
                            );
                            if (idx !== -1) set.add(idx);
                            // if not, it possibly means that section is removed from SIS
                            else console.warn(record, 'does not exist anymore');
                        }
                        schedule.All[key] = set;
                    }
                }
            } else {
                schedule.All[key] = sections;
            }
        }

        schedule.computeSchedule();
        return schedule;
    }

    /**
     * represents all courses in this schedule, stored as `(key, set of sections)` pair
     *
     * Note that if **section** is -1, it means that all sections are allowed.
     * Otherwise, **section** should be a Set of integers
     *
     * @remarks This field is called `All` (yes, with the first letter capitalized) since the very beginning
     */
    public All: { [x: string]: Set<number> | -1 };
    public title: string;
    public id: number;
    /**
     * computed based on `this.All` by `computeSchedule`
     */
    public days: {
        [x: string]: ScheduleBlock[];
        Mo: ScheduleBlock[];
        Tu: ScheduleBlock[];
        We: ScheduleBlock[];
        Th: ScheduleBlock[];
        Fr: ScheduleBlock[];
    };
    /**
     * total credits stored in this schedule, computed based on `this.All`
     */
    public totalCredit: number;
    /**
     * a computed list that's updated by the `computeSchedule` method
     */
    public currentCourses: Course[];
    /**
     * a computed dictionary that's updated by the `computeSchedule` method
     *
     * @remarks If a Course has multiple sections selected, a `+x` will be appended
     *
     * Example:
     * ```js
     * {"CS 2110 Lecture": "16436", "Chem 1410 Laboratory": "13424+2"}
     * ```
     */
    public currentIds: { [x: string]: string };

    public events: Event[];

    /**
     * keep track of used colors to avoid color collision
     */
    public colorSlots: Array<Set<string>>;
    public pendingCompute = 0;

    /**
     * the currently previewed (hovered) section
     */
    private _preview: Section | null;

    /**
     * Construct a `Schedule` object from its raw representation
     */
    constructor(
        raw_schedule: RawAlgoSchedule = [],
        title = 'Schedule',
        id = 0,
        events: Event[] = []
    ) {
        this.All = {};
        this.days = {
            Mo: [],
            Tu: [],
            We: [],
            Th: [],
            Fr: []
        };
        this._preview = null;
        this.title = title;
        this.id = id;
        this.colorSlots = Array.from({ length: Schedule.bgColors.length }, () => new Set<string>());
        this.totalCredit = 0;
        this.currentCourses = [];
        this.currentIds = {};
        this.events = events;

        for (const [key, , sections] of raw_schedule) {
            this.All[key] = new Set(sections);
        }
        this.computeSchedule();
    }

    /**
     * Get the background color of a hashable object
     * Usually the object is either a `Course`, a `Section`, or an `Event`
     *
     * @remarks color collision is handled by separate chaining
     */
    public getColor(obj: Hashable): string {
        const userColor = Schedule.savedColors[obj.key];
        if (userColor) {
            return userColor;
        }
        const idx = obj.hash() % Schedule.bgColors.length;
        this.colorSlots[idx].add(obj.key);
        return Schedule.bgColors[idx];
    }

    /**
     * Update a course in the schedule
     * - If the section is **already in** the schedule, delete it from the schedule
     * - If the section is **not** in the schedule, add it to the schedule
     * @param remove whether to remove the key if the set of sections is empty
     */
    public update(key: string, section: number, remove: boolean = true) {
        if (section === -1) {
            if (this.All[key] === -1) {
                if (remove) delete this.All[key];
                // empty set if remove is false
                else this.All[key] = new Set();
            } else this.All[key] = -1;
        } else {
            const sections = this.All[key];
            if (sections instanceof Set) {
                if (sections.delete(section)) {
                    if (sections.size === 0 && remove) delete this.All[key];
                } else {
                    sections.add(section);
                }
            } else {
                this.All[key] = new Set([section]);
            }
        }
        this.computeSchedule();
    }

    /**
     * preview and remove preview need to use the async version of compute
     */
    public removePreview() {
        this._preview = null;
        this.computeSchedule(false);
    }

    public preview(section: Section) {
        this._preview = section;
        this.computeSchedule(false);
    }

    public addEvent(
        days: string,
        display: boolean,
        title?: string,
        room?: string,
        description?: string
    ) {
        const newEvent = new Event(days, display, title, description, room);
        for (const e of this.events) {
            if (e.days === days || Utils.checkTimeConflict(newEvent.toTimeDict(), e.toTimeDict())) {
                throw new Error(`Your new event conflicts with ${e.title}`);
            }
        }
        this.events.push(newEvent);
        this.computeSchedule();
    }

    public deleteEvent(days: string) {
        for (let i = 0; i < this.events.length; i++) {
            if (this.events[i].days === days) {
                this.events.splice(i, 1);
                break;
            }
        }
        this.computeSchedule();
    }

    public hover(key: string, strong: boolean = true) {
        const sections = this.All[key];
        if (sections instanceof Set) {
            Object.values(this.days).forEach(blocks => {
                for (const block of blocks) {
                    const container = block.section;
                    if (!(container instanceof Event)) {
                        if (container.has(sections, key)) block.strong = strong;
                    }
                }
            });
        }
    }

    public unhover(key: string) {
        this.hover(key, false);
    }

    /**
     * Compute the schedule view based on `this.All` and `this.preview`.
     * If there is a pending compute task, remove that pending task.
     *
     * @param sync if true, synchronously execute this function, otherwise use setTimeout
     *
     * @remarks this method has a very high time complexity.
     * However, because we're running on small input sets (usually contain no more than 20 sections), it
     * usually completes within 50ms.
     */
    public computeSchedule(sync = true) {
        window.clearTimeout(this.pendingCompute);
        if (sync) {
            this._computeSchedule();
        } else {
            this.pendingCompute = window.setTimeout(() => {
                this._computeSchedule();
            }, 10);
        }
    }

    /**
     * synchronous version of `computeSchedule`
     */
    private _computeSchedule() {
        const catalog = window.catalog;
        if (!catalog) return;

        // console.time('compute schedule');
        this.cleanSchedule();

        for (const key in this.All) {
            const sections = this.All[key];
            /**
             * the full course record of key `key`
             */
            const course = catalog.getCourse(key, sections);
            this.currentCourses.push(course);

            // skip placing empty/faked courses
            if (!course.sections.length) continue;

            const credit = parseFloat(course.units);
            this.totalCredit += isNaN(credit) ? 0 : credit;

            const currentIdKey = `${course.department} ${course.number} ${course.type}`;

            // if any section
            if (sections === -1) {
                this.currentIds[currentIdKey] = ' - ';
                this.place(course);
            } else {
                // only one section: place that section
                if (sections.size === 1) {
                    const sec = course.getFirstSection();
                    this.currentIds[currentIdKey] = sec.id.toString();
                    this.place(sec);
                } else if (sections.size > 0) {
                    if (Schedule.options.multiSelect) {
                        // try to combine sections even if we're in multi-select mode
                        const combined = Object.values(course.getCombined()).map(secs =>
                            Section.sectionsToCourse(secs)
                        );
                        const id = combined[0].getFirstSection().id;

                        // count the total number of sections in this combined course array
                        const num = sections.size - 1;
                        for (const crs of combined) {
                            this.currentIds[currentIdKey] = num
                                ? `${id.toString()}+${num}` // use +n if there're multiple sections
                                : id.toString();
                            this.place(crs);
                        }
                    } else {
                        // a subset of the sections
                        this.place(course);
                        this.currentIds[currentIdKey] =
                            course.getFirstSection().id.toString() + '+' + (sections.size - 1);
                    }
                }
            }
        }

        if (this._preview) {
            const section = this._preview;

            // do not place into the schedule if the section is already rendered
            // instead, we highlight the schedule
            let found = false;
            for (const day in this.days) {
                const blocks = this.days[day];
                for (const block of blocks) {
                    if (!(block.section instanceof Event) && block.section.has(section)) {
                        found = block.strong = true;
                    }
                }
            }
            if (!found) {
                this.place(section);
            }
        }

        // sort currentCourses in alphabetical order
        this.currentCourses.sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? -1 : 1));

        for (const event of this.events) if (event.display) this.place(event);

        // this.computeConflict();
        this.constructAdjList();
        // console.timeEnd('compute schedule');
    }

    /**
     * Construct an undirected graph for the scheduleBlocks in each day.
     * Perform DFS on that graph to determine the
     * maximum number of conflicting schedules that need to be rendered "in parallel".
     *
     * @param countEvent whether to include events in this graph
     */
    public computeConflict(countEvent = true) {
        const graph: Graph<number> = new Map();

        // construct conflict graph for each column
        for (const day in this.days) {
            const blocks = countEvent
                ? this.days[day]
                : this.days[day].filter(block => !(block.section instanceof Event));

            // instantiate all the nodes
            const nodes: Vertex<number>[] = [];

            for (let i = 0; i < blocks.length; i++) {
                const v = new Vertex(i);
                nodes.push(v);
                graph.set(v, []);
            }

            // construct an undirected graph for all scheduleBlocks.
            // the edge from node i to node j exists iff block[i] conflicts with block[j]
            for (let i = 0; i < blocks.length; i++) {
                for (let j = i + 1; j < blocks.length; j++) {
                    if (blocks[i].conflict(blocks[j])) {
                        graph.get(nodes[i])!.push(nodes[j]);
                        graph.get(nodes[j])!.push(nodes[i]);
                    }
                }
            }

            // perform a depth-first search
            depthFirstSearch(graph);
            this.calculateWidth(graph, blocks);

            graph.clear();
        }
    }

    public calculateWidth(graph: Graph<number>, blocks: ScheduleBlock[]) {
        for (const node of graph.keys()) {
            // skip any non-root node in the depth-first trees
            if (node.parent) continue;

            // traverse all the paths starting from the root
            const paths = node.path;
            for (const path of paths) {
                // compute the left and width of the root node if they're not computed
                const firstBlock = blocks[path[0].val];
                if (firstBlock.left === -1) {
                    firstBlock.left = 0;
                    firstBlock.width = 1 / (path[0].pathDepth + 1);
                }

                // computed the left and width of the remaining nodes based on
                // the already computed information of the previous node
                for (let i = 1; i < path.length; i++) {
                    const block = blocks[path[i].val];
                    const previousBlock = blocks[path[i - 1].val];

                    block.left = Math.max(block.left, previousBlock.left + previousBlock.width);

                    // remaining width / number of remaining path length
                    block.width = (1 - block.left) / (path[i].pathDepth - path[i].depth + 1);
                }
            }
        }
    }

    public constructAdjList() {
        for (const day in this.days) {
            const blocks = this.days[day].sort((a, b) => +b - +a);
            const graph: number[][] = blocks.map(() => []);

            // construct an undirected graph
            for (let i = 0; i < blocks.length; i++) {
                for (let j = i + 1; j < blocks.length; j++) {
                    if (blocks[i].conflict(blocks[j])) {
                        graph[i].push(j);
                        graph[j].push(i);
                    }
                }
            }
            // convert to typed array so its much faster
            const fastGraph = graph.map(x => Int8Array.from(x));
            const colors = new Int8Array(fastGraph.length);
            const _ = graphColoringExact(fastGraph, colors);
            // const [colors, _] = dsatur(fastGraph);

            this.calculateWidth(colorDepthSearch(fastGraph, colors), blocks);
        }
    }

    /**
     * places a `Section`/`Course`/`Event`/ into one of the `Mo` to `Fr` array according to its `days` property
     *
     * @remarks we can place a Course instance if all of its sections occur at the same time
     */
    public place(course: Section | Course | Event) {
        if (course instanceof Section) {
            const color = this.getColor(course);
            for (const meeting of course.meetings) {
                this.placeHelper(color, meeting.days, course);
            }
        } else if (course instanceof Event) {
            if (course.display) {
                this.placeHelper(this.getColor(course), course.days, course);
            }
        } else {
            if (!course.allSameTime()) return;
            const courseSec = course.sections;
            const firstSec = courseSec[0];
            // if only one section, just use the section rather than the section array
            if (courseSec.length === 1) {
                const color = this.getColor(firstSec);
                for (const meeting of firstSec.meetings)
                    this.placeHelper(color, meeting.days, firstSec);
            } else {
                if (Schedule.options.combineSections) {
                    const color = this.getColor(course);
                    for (const meeting of firstSec.meetings)
                        this.placeHelper(color, meeting.days, course);
                } else {
                    // if we don't combined the sections, we call place each section
                    for (const section of course.sections) {
                        // note: sections belonging to the same course will have the same color
                        const color = this.getColor(section);
                        for (const meeting of section.meetings)
                            this.placeHelper(color, meeting.days, section);
                    }
                }
            }
        }
    }

    public placeHelper(color: string, dayTimes: string, events: Section | Course | Event) {
        const [days, start, , end] = dayTimes.split(' ');
        if (days && start && end) {
            const startMin = Utils.to24hr(start);
            const endMin = Utils.to24hr(end);
            // wait... start time equals end time?
            if (startMin === endMin) {
                console.warn(events, startMin, endMin);
                return;
            }
            for (let i = 0; i < days.length; i += 2) {
                const scheduleBlock = new ScheduleBlock(color, startMin, endMin, events);
                this.days[days.substr(i, 2)].push(scheduleBlock);
            }
        }
    }

    /**
     * Remove a course (and all its sections) from the schedule
     */
    public remove(key: string) {
        delete this.All[key];
        this.computeSchedule();
    }

    public cleanSchedule() {
        for (const key in this.days) {
            this.days[key] = [];
        }
        this.colorSlots.forEach(x => x.clear());
        this.totalCredit = 0;
        this.currentCourses = [];
        this.currentIds = {};
    }

    /**
     * instantiate a `Schedule` object from its JSON representation
     */
    public fromJSON(obj?: ScheduleJSON) {
        return Schedule.fromJSON(obj);
    }

    /**
     * Serialize `this` to JSON
     */
    public toJSON() {
        const obj: ScheduleJSON = {
            All: {},
            id: this.id,
            title: this.title,
            events: this.events
        };
        const catalog = window.catalog;
        // convert set to array
        for (const key in this.All) {
            const sections = this.All[key];
            if (sections instanceof Set) {
                obj.All[key] = [...sections].map(sid => {
                    const { id, section } = catalog.getSection(key, sid);
                    return { id, section };
                });
            } else obj.All[key] = sections;
        }
        return obj;
    }

    /**
     * get a copy of this schedule
     */
    public copy(deepCopyEvent = true) {
        const AllCopy: { [x: string]: Set<number> | -1 } = {};
        for (const key in this.All) {
            const sections = this.All[key];
            if (sections instanceof Set) {
                AllCopy[key] = new Set(sections);
            } else {
                AllCopy[key] = sections;
            }
        }
        // note: is it desirable to deep-copy all the events?
        const cpy = new Schedule(
            [],
            this.title,
            this.id,
            deepCopyEvent ? this.events.map(e => e.copy()) : this.events
        );
        cpy.All = AllCopy;
        cpy.computeSchedule();
        return cpy;
    }

    /**
     * Check whether the given key exists in the Schedule.
     * @param key
     * @param rendered (default to true)
     * if true, only returns true if the course/event with the given key is rendered
     */
    public has(key: string, rendered = true) {
        if (rendered)
            return (
                this.events.some(x => x.days === key) ||
                Object.values(this.days)
                    .flat(2)
                    .find(x => x.section.key === key) !== undefined
            );
        else return key in this.All || this.events.some(x => x.days === key);
    }

    public clean() {
        this.cleanSchedule();
        this.All = {};
        this._preview = null;
    }

    public empty() {
        return Object.keys(this.All).length === 0;
    }
}
