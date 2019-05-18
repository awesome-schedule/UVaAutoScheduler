/**
 * the modal module handles modal triggering
 * @author Hanzhi Zhou
 */

/**
 *
 */
import { Module, VuexModule, Mutation, getModule } from 'vuex-module-decorators';
import store from '.';
import Section from '../models/Section';
import Course from '../models/Course';
import $ from 'jquery';
import 'bootstrap';

export interface ModalState {
    modalSection: Section | null;
    modalCourse: Course | null;
}

@Module({
    store,
    name: 'modal',
    dynamic: true
})
class Modal extends VuexModule implements ModalState {
    modalSection: Section | null = null;
    modalCourse: Course | null = null;

    @Mutation
    showSectionModal(section: Section) {
        this.modalSection = section;
        $('#section-modal').modal();
    }

    @Mutation
    showCourseModal(course: Course) {
        this.modalCourse = course;
        $('#course-modal').modal();
    }
}

export const modal = getModule(Modal);
export default modal;